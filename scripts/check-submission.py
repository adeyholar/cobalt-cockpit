#!/usr/bin/env python3
"""Check an extracted Git source artifact; this is not Anthropic validation."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('artifact', type=Path)
parser.add_argument('--source-sha', required=True)
parser.add_argument('--version', required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
root = args.artifact.resolve(strict=True)
findings = []
holds = []

def git(*argv):
    return subprocess.check_output(['git', '--no-replace-objects', '-C', str(source), *argv])

sha = git('rev-parse', '--verify', args.source_sha + '^{commit}').decode().strip()
expected = {}
for entry in git('ls-tree', '-rz', '--full-tree', sha).split(b'\0'):
    if not entry:
        continue
    meta, name = entry.split(b'\t', 1)
    mode, kind, oid = meta.decode().split()
    rel = name.decode()
    if kind != 'blob' or mode not in ('100644', '100755'):
        findings.append(f'{rel}: unsupported source entry {mode} {kind}')
        continue
    expected[rel] = (mode, oid)

actual = {}
for path in sorted(root.rglob('*')):
    rel = path.relative_to(root).as_posix()
    if path.is_symlink():
        findings.append(f'{rel}: symbolic link')
    elif path.is_file():
        actual[rel] = path
for rel in sorted(expected.keys() - actual.keys()):
    findings.append(f'{rel}: missing from artifact')
for rel in sorted(actual.keys() - expected.keys()):
    findings.append(f'{rel}: not in source commit')
for rel in sorted(expected.keys() & actual.keys()):
    mode, oid = expected[rel]
    data = actual[rel].read_bytes()
    if data != git('cat-file', 'blob', oid):
        findings.append(f'{rel}: content differs from source commit')
    if bool(actual[rel].stat().st_mode & 0o111) != (mode == '100755'):
        findings.append(f'{rel}: executable mode differs from source commit')
    if len(data) > 5 * 1024 * 1024:
        findings.append(f'{rel}: exceeds 5 MiB directory limit')
    if len(data) >= 256 * 1024 and actual[rel].suffix.lower() not in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.ttf', '.otf'):
        holds.append(f'{rel}: non-image/font file at least 256 KiB')
    if actual[rel].suffix == '.wav':
        holds.append(f'{rel}: binary sound requires manual review')
if len(actual) > 512:
    holds.append('artifact contains more than 512 files')

def inside(base, value):
    if not isinstance(value, str) or not value.startswith('./'):
        findings.append(f'{base.relative_to(root)}: entrypoint must be a relative ./ path')
        return None
    path = (base / value).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        findings.append(f'{value}: entrypoint is missing or outside artifact')
        return None
    return path

manifest = json.loads((root / '.claude-plugin/plugin.json').read_text())
market = json.loads((root / '.claude-plugin/marketplace.json').read_text())
if manifest.get('version') != args.version or market['plugins'][0].get('version') != args.version:
    findings.append('plugin and marketplace versions do not match expected version')
for key in ('types', 'icon'):
    inside(root, manifest.get(key))
hooks = json.loads((root / 'hooks/hooks.json').read_text())
for value in hooks.get('modules', []):
    inside(root / 'hooks', value)

# Static imports must resolve to code shipped inside the plugin. Declaration
# imports are deliberately separate from runtime imports. No portal codeFile
# metadata has been supplied: hooks.json modules are the real host entrypoints.
for rel, path in actual.items():
    if not rel.startswith('hooks/') or path.suffix not in ('.ts', '.tsx'):
        continue
    text = path.read_text()
    for match in re.finditer(r'^import\s+(?!type\b)[\s\S]*?\bfrom\s+[\x27\x22](\.[^\x27\x22]+)[\x27\x22]', text, re.M):
        base = path.parent / match.group(1)
        choices = [Path(str(base) + ext) for ext in ('.ts', '.tsx', '/index.ts', '/index.tsx')]
        if not any(p.resolve().is_relative_to(root) and p.is_file() for p in choices):
            findings.append(f'{rel}: runtime import {match.group(1)} has no shipped code file')

inventory = [{'path': rel, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for rel, path in sorted(actual.items())]
report = {'layer': 'local static submission artifact check', 'anthropic_external_validation': 'NOT VERIFIED', 'source_sha': sha, 'version': args.version, 'artifact': str(root), 'file_count': len(actual), 'blocking_findings': findings, 'manual_review_holds': holds, 'files': inventory}
print(json.dumps(report, indent=2))
sys.exit(bool(findings))
