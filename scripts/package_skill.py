"""Build the portable skill ZIP without runtime data or local caches."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
skill = root / 'skills' / 'easyhey-firmware'
output = root / 'dist' / 'easyhey-firmware.zip'
allowed = [skill / 'SKILL.md', skill / 'agents' / 'openai.yaml']
allowed += sorted((skill / 'references').glob('*.md'))
allowed += sorted((skill / 'scripts').glob('*.mjs'))
allowed += sorted((skill / 'scripts').glob('*.py'))
assert all(path.is_file() and not path.is_symlink() for path in allowed)
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for path in allowed:
        archive.write(path, Path(skill.name) / path.relative_to(skill))
    archive.write(root / 'LICENSE', Path(skill.name) / 'LICENSE')
print(f'Packaged {len(allowed) + 1} files: {output}')
