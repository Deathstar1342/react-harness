"""Portable adapter-policy tests. These do not claim real apt execution."""
import importlib
import sys
import types
import unittest
from unittest.mock import patch
from core import Rejected

apt = types.ModuleType('apt')
apt.progress = types.ModuleType('apt.progress')
apt.progress.base = types.ModuleType('apt.progress.base')
modules = {'apt': apt, 'apt.progress': apt.progress, 'apt.progress.base': apt.progress.base,
           'apt_pkg': types.ModuleType('apt_pkg')}
with patch.dict(sys.modules, modules):
    adapter_module = importlib.import_module('apt_adapter')


class Package:
    def __init__(self, name='hello', installed=False):
        self.name = name
        self.is_installed = installed
        self.marked_install = True
        self.marked_upgrade = True  # Observed even for a new install in real libapt.
        self.marked_delete = self.marked_downgrade = self.marked_reinstall = self.essential = False
        origin = types.SimpleNamespace(origin='Ubuntu', label='Ubuntu', archive='noble', component='main', site='archive.ubuntu.com', trusted=True)
        self.candidate = types.SimpleNamespace(version='2.10-3', architecture='amd64', origins=[origin],
            uris=['http://archive.ubuntu.com/ubuntu/pool/hello.deb'], record={'SHA256': 'a' * 64}, size=1000, installed_size=2000)
        self.installed = self.candidate if installed else None
        self.versions = {self.candidate.version: self.candidate}
    def mark_install(self, **kwargs):
        pass


class Cache(dict):
    broken_count = delete_count = 0
    def __iter__(self):
        return iter(self.values())
    def get_changes(self):
        return self.changes


class EmptyPath:
    def __init__(self, *args):
        pass
    def is_file(self):
        return False
    def glob(self, *args):
        return []


class AdapterTest(unittest.TestCase):
    def preview(self, packages, requested=None, changes=None):
        cache = Cache({p.name: p for p in packages})
        cache.changes = packages if changes is None else changes
        adapter = object.__new__(adapter_module.AptAdapter)
        adapter.target = lambda: {'id': 'a' * 64}
        adapter.healthy = lambda cache: True
        with patch.object(apt, 'Cache', return_value=cache, create=True), patch.object(adapter_module, 'Path', EmptyPath), patch.object(adapter_module, 'hash_files', return_value='b' * 64):
            return adapter.preview({'packages': requested or [{'name': 'hello'}]})
    def test_new_package_upgrade_flag_is_not_existing_upgrade(self):
        result = self.preview([Package()])
        self.assertEqual(result['packages'][0]['version'], '2.10-3')
    def test_existing_dependency_mutation_rejected(self):
        with self.assertRaisesRegex(Rejected, 'EXISTING_PACKAGE_CHANGE'):
            self.preview([Package(), Package('dependency', installed=True)])
    def test_removal_downgrade_reinstall_essential_rejected(self):
        for field in ('marked_delete', 'marked_downgrade', 'marked_reinstall', 'essential'):
            with self.subTest(field=field), self.assertRaises(Rejected):
                package = Package()
                setattr(package, field, True)
                self.preview([package])
    def test_untrusted_unknown_credentialed_local_artifacts_rejected(self):
        for change in ('trust', 'hash', 'size', 'local', 'userinfo', 'query'):
            with self.subTest(change=change), self.assertRaises(Rejected):
                package = Package()
                version = package.candidate
                if change == 'trust': version.origins[0].trusted = False
                if change == 'hash': version.record = {}
                if change == 'size': version.installed_size = 0
                if change == 'local': version.uris = ['file:/tmp/package.deb']
                if change == 'userinfo': version.uris = ['https://secret:password@archive.ubuntu.com/p.deb']
                if change == 'query': version.uris = ['https://archive.ubuntu.com/p.deb?token=secret']
                self.preview([package])
    def test_installed_noop_and_wrong_explicit_version(self):
        package = Package(installed=True)
        self.assertEqual(self.preview([package], changes=[])['packages'], [])
        with self.assertRaisesRegex(Rejected, 'EXISTING_PACKAGE_CHANGE'):
            self.preview([package], requested=[{'name': 'hello', 'version': '0.0'}], changes=[])
    def test_explicit_unavailable_and_size_limits(self):
        with self.assertRaisesRegex(Rejected, 'VERSION_UNAVAILABLE'):
            self.preview([Package()], requested=[{'name': 'hello', 'version': '0.0'}])
        package = Package()
        package.candidate.size = 129 * 1024 * 1024
        with self.assertRaisesRegex(Rejected, 'UNBOUNDED_PLAN'):
            self.preview([package])


if __name__ == '__main__':
    unittest.main()
