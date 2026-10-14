/* Main-process lifetime lease using stable N-API v8 opaque handles. */
#include <stdbool.h>
#ifdef _WIN32
#include <windows.h>
#define EXPORT __declspec(dllexport)
#define SYMBOL(name) GetProcAddress(GetModuleHandleW(NULL), name)
static HANDLE lease;
#else
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#define EXPORT __attribute__((visibility("default")))
#define SYMBOL(name) dlsym(RTLD_DEFAULT, name)
static int lease = -1;
#endif
typedef void *napi_env;
typedef void *napi_value;
typedef int (*get_boolean_fn)(napi_env, bool, napi_value *);
typedef int (*set_property_fn)(napi_env, napi_value, const char *, napi_value);
typedef int (*throw_error_fn)(napi_env, const char *, const char *);
EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  get_boolean_fn get_boolean = (get_boolean_fn)SYMBOL("napi_get_boolean");
  set_property_fn set_property = (set_property_fn)SYMBOL("napi_set_named_property");
  throw_error_fn throw_error = (throw_error_fn)SYMBOL("napi_throw_error");
  if (!get_boolean || !set_property || !throw_error) return NULL;
  int acquired = 0;
#ifdef _WIN32
  lease = CreateMutexW(NULL, TRUE, L"Global\\abysSUS-package-maintenance-v1");
  DWORD error = GetLastError();
  acquired = lease != NULL && error != ERROR_ALREADY_EXISTS;
  if (!acquired && lease) { CloseHandle(lease); lease = NULL; }
#else
  struct stat st;
  lease = open("/var/lib/abyssus-package/runtime.lock", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (lease >= 0 && fstat(lease, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 0022) && flock(lease, LOCK_SH | LOCK_NB) == 0) {
    acquired = lstat("/var/lib/abyssus-package/maintenance", &st) != 0 && errno == ENOENT;
  }
  if (!acquired && lease >= 0) { close(lease); lease = -1; }
#endif
  if (!acquired) { (void)throw_error(env, "PACKAGE_BUSY", "Package maintenance or another installation is active. Close it normally or finish package repair, then retry."); return NULL; }
  napi_value value;
  if (get_boolean(env, true, &value) != 0 || set_property(env, exports, "held", value) != 0) return NULL;
  // Intentionally no release method/finalizer: only OS process exit releases it.
  return exports;
}
EXPORT int node_api_module_get_api_version_v1(void) { return 8; }
