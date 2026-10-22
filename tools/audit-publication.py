"""Scan reachable Git objects, including archived source, without printing secrets."""
import hashlib
import io
import pathlib
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
HOME = re.compile(rb"(?:[A-Za-z]:[\\/]+Users[\\/]+|/Users/|/home/)([A-Za-z0-9_. -]+)(?=[\\/\r\n`\"<>]|$)")
GENERIC_USERS = {b"Developer", b"developer", b"runner", b"runneradmin", b"vagrant", b"oai", b"Public", b"CodexSandboxOffline", b"node_modules"}
seen = set()
errors = []
counts = {"objects": 0, "archives": 0, "contents": 0}


def inspect(data, origin, destination, depth=0):
    digest = hashlib.sha256(data).hexdigest()
    if digest in seen:
        return
    seen.add(digest)
    counts["contents"] += 1
    for match in HOME.finditer(data):
        # Npm walks ancestor directories such as /Users/node_modules/.bin.
        # A comment may mention a generic sandbox user followed by prose.
        if match.group(1).strip().split(b" ", 1)[0] not in GENERIC_USERS:
            errors.append(f"Personal home-directory candidate: {origin}")
            break
    if zipfile.is_zipfile(io.BytesIO(data)):
        if depth >= 8:
            raise RuntimeError(f"Archive nesting exceeds audit limit: {origin}")
        counts["archives"] += 1
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for entry in archive.infolist():
                if not entry.is_dir():
                    inspect(archive.read(entry), origin + "!" + entry.filename, destination, depth + 1)
        return
    # Write each unique payload to a generated filename, never an archive path.
    # Use .txt so binary extensions cannot make the scanner skip embedded text.
    (destination / (digest + ".txt")).write_bytes(data)


def main():
    scanner = shutil.which("gitleaks")
    if scanner is None:
        raise SystemExit("Install Gitleaks 8.30.1 or later before running this audit.")
    refs = subprocess.check_output(["git", "rev-list", "--objects", "--all"], cwd=ROOT).splitlines()
    with tempfile.TemporaryDirectory(prefix="publication-audit-") as temporary:
        destination = pathlib.Path(temporary)
        process = subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            for item in refs:
                oid, _, name = item.partition(b" ")
                process.stdin.write(oid + b"\n")
                process.stdin.flush()
                header = process.stdout.readline().split()
                if len(header) != 3:
                    raise RuntimeError("Missing Git object: " + oid.decode())
                data = process.stdout.read(int(header[2]))
                if len(data) != int(header[2]) or process.stdout.read(1) != b"\n":
                    raise RuntimeError("Incomplete Git object: " + oid.decode())
                kind = header[1]
                if kind not in (b"blob", b"commit", b"tag"):
                    continue
                counts["objects"] += 1
                origin = oid.decode() + ":" + (name or kind).decode("utf-8", "replace")
                if kind in (b"commit", b"tag"):
                    for email in re.findall(rb"^(?:author|committer|tagger) .*<([^>]+)>", data, re.M):
                        if not email.endswith(b"@users.noreply.github.com") and email != b"noreply@github.com":
                            errors.append("Non-private commit email: " + origin)
                inspect(data, origin, destination)
        finally:
            process.stdin.close()
            process.stdout.close()
            process.wait()
        result = subprocess.run([scanner, "dir", str(destination), "--config", str(ROOT / ".gitleaks.toml"), "--redact", "--no-banner", "--max-decode-depth", "3"])
    for error in errors:
        print(error)
    print(counts)
    if errors or result.returncode:
        raise SystemExit(1)
    print("Automated checks passed; screenshot and GitHub surface review still required.")


if __name__ == "__main__":
    main()
