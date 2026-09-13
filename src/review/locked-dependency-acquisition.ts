import type { SandboxSession } from "eve/sandbox";
import { requireSandboxCommand } from "./sandbox-acquisition";

export const lockedDependencyDeclarations: readonly string[] = ["lwpt.toml", "lwpt.lock", ".lwpt-version"];
const cacheRoot = "/tmp/slop-sheriff-locked-cache";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Static application code: declarations are parsed as data, never imported or
// executed. The online branch only downloads hash-pinned bytes. LWPT hooks and
// its frozen graph/hash verification run later in the offline review sandbox.
const adapter = String.raw`
import base64, hashlib, json, os, pathlib, re, shutil, sys, tarfile, tempfile, urllib.parse, urllib.request
try:
    import tomllib
except ImportError:
    raise RuntimeError('Locked LWPT acquisition requires Python 3.11 or newer')
data = json.loads(base64.b64decode(sys.argv[1]))
mode, project, cache = sys.argv[2], pathlib.Path(sys.argv[3]).resolve(), pathlib.Path(sys.argv[4]).resolve()
manifest = tomllib.loads(data['lwpt.toml'])
lock = tomllib.loads(data['lwpt.lock'])
if lock.get('version') not in (2, 3): raise ValueError('Unsupported LWPT lock schema')
packages = lock.get('package', {})
if not isinstance(packages, dict): raise ValueError('Invalid LWPT locked package table')

def safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or value.startswith(('/', '~')) or re.match(r'^[A-Za-z]:', value):
        raise ValueError('Unsafe LWPT path')
    if any(ord(c) < 32 for c in value) or '..' in value.split('/') or '.git' in value.split('/'):
        raise ValueError('Unsafe LWPT path')
    return value

def below(root, path):
    resolved = path.resolve()
    if not resolved.is_relative_to(root) or resolved == root: raise ValueError('LWPT path escapes its root')
    return path

def target_path(root, value):
    candidate = root / safe_relative(value)
    below(root, candidate)
    cursor = candidate
    while cursor != root:
        if cursor.is_symlink(): raise ValueError('LWPT destination traverses a symlink')
        cursor = cursor.parent
    return candidate

def archive_digest(entry):
    digest = entry.get('archiveHash', '')
    if not re.fullmatch(r'sha256:[a-fA-F0-9]{64}', digest): raise ValueError('LWPT archive requires a locked SHA-256')
    return digest[7:].lower()

def verify(path, digest):
    hasher = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''): hasher.update(chunk)
    if hasher.hexdigest() != digest: raise ValueError('LWPT archive SHA-256 mismatch')

def is_local(entry):
    source = entry.get('source', '')
    return entry.get('sourceIdentity', '').startswith('local|') or source.startswith(('./', '../', '/', '~/', 'local:', 'workspace:'))

for name, entry in packages.items():
    if not isinstance(entry, dict) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name): raise ValueError('Invalid LWPT package name')

if mode == 'acquire':
    cache.mkdir(parents=True, exist_ok=True)
    for name, entry in packages.items():
        if is_local(entry): continue
        digest = archive_digest(entry)
        destination = target_path(cache, digest + '.tar.gz')
        if destination.exists(): verify(destination, digest); continue
        url = entry.get('resolvedURL', '')
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError('LWPT acquisition requires a locked HTTPS archive URL')
        temporary = destination.with_suffix('.download')
        try:
            with urllib.request.urlopen(url) as response, open(temporary, 'wb') as output:
                if urllib.parse.urlsplit(response.url).scheme != 'https': raise ValueError('LWPT redirect must remain HTTPS')
                shutil.copyfileobj(response, output)
            verify(temporary, digest)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    sys.exit(0)

if mode != 'materialize': raise ValueError('Unknown locked acquisition operation')
settings = manifest.get('lwpt', {})
modules = target_path(project, settings.get('modules-dir') or '.lwpt/modules')
archives = target_path(project, settings.get('archives-dir') or '.lwpt/archives')
modules.mkdir(parents=True, exist_ok=True)
archives.mkdir(parents=True, exist_ok=True)

def match_glob(path, pattern):
    paths = [p for p in path.split('/') if p]
    patterns = [p for p in pattern.replace('\\', '/').split('/') if p]
    def match(i, j):
        if j == len(patterns): return i == len(paths)
        if patterns[j] == '**': return any(match(k, j + 1) for k in range(i, len(paths) + 1))
        if i == len(paths): return False
        expression = ''.join('.*' if c == '*' else '.' if c == '?' else re.escape(c) for c in patterns[j])
        return re.fullmatch(expression, paths[i]) is not None and match(i + 1, j + 1)
    return match(0, 0)

policies = {}
def read_policies(document):
    for name, declaration in document.get('dependencies', {}).items():
        if not isinstance(declaration, dict): continue
        policy = tuple(tuple(sorted(set(declaration.get(key, [])))) for key in ('include', 'exclude'))
        if any(not isinstance(item, str) for group in policy for item in group): raise ValueError('Invalid LWPT filter')
        if name in policies and policies[name] != policy: raise ValueError('Conflicting LWPT extraction policies')
        policies[name] = policy
read_policies(manifest)

def copy_local(source, destination):
    below(project, source)
    if not source.is_dir(): raise ValueError('Locked local LWPT source is absent from the checkout')
    if destination.resolve().is_relative_to(source.resolve()): raise ValueError('Cannot recursively copy a local dependency into itself')
    destination.mkdir(parents=True, exist_ok=True)
    for root, dirs, files in os.walk(source, followlinks=False):
        dirs[:] = [name for name in dirs if not (pathlib.Path(root) / name).is_symlink()]
        relative = pathlib.Path(root).relative_to(source)
        (destination / relative).mkdir(parents=True, exist_ok=True)
        for name in files:
            original = pathlib.Path(root) / name
            if original.is_symlink() and not original.exists(): continue
            below(project, original)
            if not original.is_file(): raise ValueError('Unsupported local LWPT special file')
            shutil.copyfile(original, destination / relative / name)

def extract(archive, destination):
    links = []
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            # LWPT 0.5.1 strips exactly the first archive path component.
            original = member.name.replace('\\', '/')
            if original.startswith('/') or '..' in original.split('/'): raise ValueError('Unsafe LWPT archive entry')
            relative = original.partition('/')[2]
            if not relative: continue
            output = target_path(destination, relative)
            if member.issym() or member.islnk():
                target = member.linkname.replace('\\', '/')
                if target.startswith('/') or re.match(r'^[A-Za-z]:', target): raise ValueError('Unsafe LWPT archive link')
                resolved = below(destination, output.parent / target)
                links.append((output, resolved))
            elif member.isdir(): output.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                output.parent.mkdir(parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None: raise ValueError('Missing LWPT archive member bytes')
                with stream, open(output, 'wb') as dest: shutil.copyfileobj(stream, dest)
            else: raise ValueError('Unsupported LWPT archive special file')
    # Native LWPT copies link targets rather than creating filesystem links.
    for output, target in links:
        output.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file(): shutil.copyfile(target, output)
        elif target.is_dir() and not output.resolve().is_relative_to(target.resolve()): shutil.copytree(target, output, dirs_exist_ok=True)

staged = {}
with tempfile.TemporaryDirectory(prefix='slop-sheriff-lwpt-', dir=cache.parent) as temporary:
    staging = pathlib.Path(temporary)
    for name, entry in packages.items():
        destination = target_path(modules, name)
        if not is_local(entry):
            digest = archive_digest(entry)
            cached = target_path(cache, digest + '.tar.gz')
            verify(cached, digest)
            tag = 'url' if entry.get('source', '').startswith('https://') else re.sub(r'[^A-Za-z0-9._-]', '_', entry.get('resolvedRef', '')) or 'ref'
            archived = target_path(archives, name + '-' + tag + '.tar.gz')
            if archived.exists(): verify(archived, digest)
            else: shutil.copyfile(cached, archived)
        # Keep committed or previously materialized bytes for native verification.
        if destination.exists():
            if not destination.is_dir(): raise ValueError('LWPT module destination is not a directory')
            staged[name] = (destination, False)
            continue
        output = staging / name
        output.mkdir()
        if is_local(entry):
            identity = entry.get('sourceIdentity', '')
            local = identity.split('|')[1] if identity.startswith('local|') else entry.get('source', '').removeprefix('local:')
            if local.startswith('workspace:'): raise ValueError('Locked workspace requires canonical local sourceIdentity')
            copy_local(project / safe_relative(local), output)
        else: extract(cached, output)
        staged[name] = (output, True)
    # Legacy locks lack sourceIdentity; recover filters from declarative manifests
    # in the extracted dependency graph before applying any filter.
    for output, fresh in staged.values():
        manifests = sorted(output.rglob('lwpt.toml'), key=lambda path: (len(path.relative_to(output).parts), str(path)))
        if manifests:
            below(output.resolve(), manifests[0])
            read_policies(tomllib.loads(manifests[0].read_text()))
    for name, (output, fresh) in staged.items():
        if not fresh: continue
        identity = packages[name].get('sourceIdentity', '')
        if identity:
            includes = [part[8:] for part in identity.split('|') if part.startswith('include=')]
            excludes = [part[8:] for part in identity.split('|') if part.startswith('exclude=')]
        else: includes, excludes = policies.get(name, ((), ()))
        if includes or excludes:
            for root, dirs, files in os.walk(output, topdown=False):
                for file in files:
                    path = pathlib.Path(root) / file
                    relative = path.relative_to(output).as_posix()
                    if (includes and not any(match_glob(relative, p) for p in includes)) or any(match_glob(relative, p) for p in excludes): path.unlink()
                for directory in dirs:
                    path = pathlib.Path(root) / directory
                    if not any(path.iterdir()): path.rmdir()
        output.rename(target_path(modules, name))
`;

function declarations(files: ReadonlyMap<string, string>): string | null {
  if (!files.has("lwpt.toml")) return null;
  const lock = files.get("lwpt.lock");
  if (!lock) throw new Error("Locked LWPT acquisition requires lwpt.lock");
  return Buffer.from(JSON.stringify({ "lwpt.toml": files.get("lwpt.toml"), "lwpt.lock": lock })).toString("base64");
}

export async function acquireLockedEcosystemDependencies(
  sandbox: SandboxSession, files: ReadonlyMap<string, string>, _paths: readonly string[],
): Promise<readonly string[]> {
  const input = declarations(files);
  if (!input) return [];
  await requireSandboxCommand(sandbox, `python3 -I -c ${quote(adapter)} ${quote(input)} acquire /workspace ${cacheRoot}`, "Locked LWPT archive acquisition");
  return [cacheRoot];
}

export async function materializeLockedEcosystemDependencies(sandbox: Parameters<typeof requireSandboxCommand>[0], files: ReadonlyMap<string, string>): Promise<void> {
  const input = declarations(files);
  if (!input) return;
  await requireSandboxCommand(sandbox, `python3 -I -c ${quote(adapter)} ${quote(input)} materialize /workspace ${cacheRoot}`, "Offline LWPT materialization");
}
