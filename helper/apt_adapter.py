"""First adapter: bounded, authenticated repository NEW package installs only.

The service imports this only after the native launcher verifies runtime trees.
No command string, supplied path, or subprocess environment crosses this API.
"""
import hashlib
import contextlib
import os
from pathlib import Path
import platform
import re
import sys
from urllib.parse import urlsplit

sys.path.append("/usr/lib/python3/dist-packages")
import apt
import apt_pkg
import apt.progress.base
from core import require, digest, Rejected


def hash_files(roots):
    result = hashlib.sha256()
    for root in roots:
        path = Path(root)
        files = sorted(path.rglob("*")) if path.is_dir() else [path]
        for file in files:
            if file.name in ("lock", "partial", "auxfiles") or not file.is_file():
                continue
            require(not file.is_symlink(), "UNSAFE_APT_STATE")
            require(file.stat().st_uid == 0 and file.stat().st_mode & 0o022 == 0, "UNSAFE_APT_STATE")
            result.update(str(file).encode())
            with file.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    result.update(block)
    return result.hexdigest()


class AptAdapter:
    def __init__(self, installation_id):
        self.installation_id = installation_id
        self.cache = None
        apt_pkg.init_config()
        # APT_CONFIG is fixed by launcher. Never load ambient apt.conf.d hooks.
        require(apt_pkg.config.find("Dir::Etc::parts") == "-", "UNSAFE_APT_CONFIG")
        require(apt_pkg.config.find("Dir::Etc::main") == "-", "UNSAFE_APT_CONFIG")
        apt_pkg.config.set("APT::Install-Recommends", "false")
        apt_pkg.config.set("APT::Install-Suggests", "false")
        apt_pkg.config.set("Acquire::AllowInsecureRepositories", "false")
        apt_pkg.config.set("Acquire::AllowDowngradeToInsecureRepositories", "false")
        apt_pkg.config.set("APT::Get::AllowUnauthenticated", "false")
        apt_pkg.config.set("DPkg::Options::", "--force-confold")
        apt_pkg.init_system()

    def target(self):
        os_release = {}
        for line in Path("/etc/os-release").read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                os_release[k] = v.strip('"')
        require(os_release.get("ID") in ("ubuntu", "debian") and platform.machine() == "x86_64", "UNSUPPORTED_TARGET")
        value = {"installationId": self.installation_id, "machineId": Path("/etc/machine-id").read_text().strip(),
                 "distribution": os_release["ID"], "release": os_release["VERSION_ID"], "architecture": "amd64"}
        require(re.fullmatch(r"[a-f0-9]{32}", value["machineId"]), "UNSUPPORTED_TARGET")
        return {**value, "id": digest(value), "manager": "apt", "adapterVersion": 1}

    @contextlib.contextmanager
    def lock(self):
        with apt_pkg.SystemLock(), apt_pkg.FileLock("/var/lib/apt/lists/lock"):
            yield

    def healthy(self, cache):
        return not cache.broken_count and not cache.dpkg_journal_dirty and all(
            p._pkg.current_state in (apt_pkg.CURSTATE_NOT_INSTALLED, apt_pkg.CURSTATE_INSTALLED, apt_pkg.CURSTATE_CONFIG_FILES)
            for p in cache)

    def preview(self, request):
        cache = apt.Cache()
        require(self.healthy(cache), "DPKG_RECOVERY_REQUIRED")
        # Explicit trust overrides and alternative transports defeat signed repository provenance.
        for path in [Path("/etc/apt/sources.list"), *Path("/etc/apt/sources.list.d").glob("*")]:
            if not path.is_file():
                continue
            text = path.read_text().lower()
            require(not re.search(r"(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)\s*[:=]\s*(?:yes|true|1)", text), "UNSAFE_REPOSITORY")
        for item in request["packages"]:
            require(item["name"] in cache, "PACKAGE_UNAVAILABLE")
            package = cache[item["name"]]
            if package.is_installed:
                require("version" not in item or item["version"] == package.installed.version, "EXISTING_PACKAGE_CHANGE")
                continue
            if "version" in item:
                require(item["version"] in package.versions, "VERSION_UNAVAILABLE")
                package.candidate = package.versions[item["version"]]
            require(package.candidate is not None, "VERSION_UNAVAILABLE")
            package.mark_install(auto_fix=True, auto_inst=True, from_user=True)
        require(not cache.broken_count and not cache.delete_count, "UNBOUNDED_PLAN")
        changes = sorted(cache.get_changes(), key=lambda p: p.name)
        require(len(changes) <= 32, "UNBOUNDED_PLAN")
        resolved = []
        requested = {p["name"]: p.get("version") for p in request["packages"]}
        for package in changes:
            require(not package.is_installed and package.marked_install and not package.marked_delete
                    and not package.essential and not package.marked_downgrade and not package.marked_upgrade,
                    "EXISTING_PACKAGE_CHANGE")
            version = package.candidate
            require(version is not None and version.architecture in ("amd64", "all"), "UNBOUNDED_PLAN")
            if requested.get(package.name) is not None:
                require(version.version == requested[package.name], "RESOLVER_SUBSTITUTION")
            origins = [{"origin": o.origin, "label": o.label, "archive": o.archive,
                        "component": o.component, "site": o.site, "trusted": o.trusted}
                       for o in version.origins]
            require(origins and all(o["trusted"] and o["origin"] in ("Ubuntu", "Debian") and o["site"]
                                    for o in origins), "UNTRUSTED_PACKAGE")
            uris = sorted(version.uris)
            require(uris and all(urlsplit(uri).scheme in ("http", "https") and urlsplit(uri).hostname
                                 and not urlsplit(uri).username and not urlsplit(uri).password
                                 and not urlsplit(uri).query and not urlsplit(uri).fragment for uri in uris), "UNTRUSTED_PACKAGE")
            sha = version.record.get("SHA256", "")
            require(re.fullmatch(r"[a-f0-9]{64}", sha) and version.size > 0 and version.installed_size > 0, "UNKNOWN_IMPACT")
            resolved.append({"name": package.name, "version": version.version, "architecture": version.architecture,
                             "sha256": sha, "downloadBytes": version.size, "installedBytes": version.installed_size,
                             "repositories": origins, "uris": uris, "requested": package.name in requested})
        require(all(name in {p["name"] for p in resolved} or cache[name].is_installed for name in requested), "RESOLVER_SUBSTITUTION")
        download = sum(p["downloadBytes"] for p in resolved)
        installed = sum(p["installedBytes"] for p in resolved)
        require(download <= 128 * 1024 * 1024 and installed <= 512 * 1024 * 1024, "UNBOUNDED_PLAN")
        self.cache = cache
        return {"target": self.target(), "packages": resolved,
                "stateDigest": hash_files(["/var/lib/dpkg/status", "/var/lib/apt/extended_states"]),
                "repositoryDigest": hash_files(["/etc/apt", "/var/lib/apt/lists"]),
                "impact": {"newPackages": len(resolved), "downloadBytes": download, "installedBytes": installed,
                           "removals": 0, "upgrades": 0, "downgrades": 0,
                           "maintainerScripts": "trusted-package-root-execution",
                           "triggers": "may-modify-existing-packages-and-services", "serviceChanges": "package-defined"}}

    def install(self):
        require(self.cache is not None and apt_pkg.pkgsystem_is_locked(), "LOCK_REQUIRED")
        # Same resolved cache under frontend lock, with authenticated archive checks.
        # python-apt releases only dpkg's inner lock while spawning dpkg.
        require(self.cache.commit(apt.progress.base.AcquireProgress(), apt.progress.base.InstallProgress()), "APT_FAILED")

    def reconcile(self, preview):
        require(preview["target"]["id"] == self.target()["id"], "WRONG_TARGET")
        cache = apt.Cache()
        observed = []
        for item in preview["packages"]:
            package = cache[item["name"]] if item["name"] in cache else None
            version = package.installed.version if package and package.installed else None
            observed.append({"name": item["name"], "expectedVersion": item["version"], "installedVersion": version})
        return {"packages": observed, "matches": all(p["expectedVersion"] == p["installedVersion"] for p in observed),
                "healthy": self.healthy(cache)}
