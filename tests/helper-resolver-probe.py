"""Read-only fixture diagnostics: no helper credential or package effects."""
import sys
sys.path.insert(0, '/usr/lib/abyssus-helper')
from apt_adapter import apt

cache = apt.Cache()
for existing in cache:
    if existing.is_installed:
        existing.candidate = existing.installed
cache['hello'].mark_install(auto_fix=True, auto_inst=True, from_user=True)
for package in cache.get_changes():
    print({'name': package.name, 'installed': package.is_installed,
           'install': package.marked_install, 'upgrade': package.marked_upgrade,
           'downgrade': package.marked_downgrade, 'delete': package.marked_delete,
           'essential': package.essential, 'candidate': package.candidate.version})
