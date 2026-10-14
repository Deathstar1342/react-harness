/* Build with cc -static. This bootstrap must not load dynamic libraries before
 * validating the privileged Python/runtime/code hierarchy. Linux x86_64 only. */
#define _DEFAULT_SOURCE
#define _XOPEN_SOURCE 700
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

static unsigned long visited = 0;
static struct { dev_t dev; ino_t ino; } directories[50000];
static size_t directory_count=0;
static void fail(const char *path) {
    fprintf(stderr, "UNTRUSTED_HELPER_PATH: %s\n", path);
    exit(78);
}
static void check_one(const char *path) {
    struct stat st;
    if (lstat(path, &st) || st.st_uid != 0) fail(path);
    /* ACL named-user write is constrained by the group mask shown by stat.
       Reject default ACLs too. Symlink mode 0777 has no access meaning. */
    if (!S_ISLNK(st.st_mode) && (st.st_mode & 0022)) fail(path);
    if (S_ISDIR(st.st_mode) && getxattr(path,"system.posix_acl_default",NULL,0)>0) fail(path);
    if (!S_ISDIR(st.st_mode) && !S_ISREG(st.st_mode) && !S_ISLNK(st.st_mode)) fail(path);
}
static void hierarchy(const char *path) {
    char copy[PATH_MAX], resolved[PATH_MAX];
    if (strlen(path)>=sizeof(copy) || path[0]!='/') fail(path);
    strcpy(copy,path);
    for(char *p=copy+1; *p; ++p) if(*p=='/') { *p=0; check_one(copy); *p='/'; }
    check_one(copy);
    if(!realpath(path,resolved)) fail(path);
    if(strcmp(path,resolved)) {
        strcpy(copy,resolved);
        for(char *p=copy+1; *p; ++p) if(*p=='/') { *p=0; check_one(copy); *p='/'; }
        check_one(copy);
    }
    check_one("/");
}
static void tree(const char *path, unsigned depth) {
    if(++visited>300000 || depth>48) fail("runtime scan bound exceeded");
    hierarchy(path);
    struct stat st;
    if(stat(path,&st)) fail(path);
    if(!S_ISDIR(st.st_mode)) return;
    for(size_t i=0;i<directory_count;i++) if(directories[i].dev==st.st_dev && directories[i].ino==st.st_ino) return;
    if(directory_count==50000) fail("directory scan bound exceeded");
    directories[directory_count].dev=st.st_dev; directories[directory_count++].ino=st.st_ino;
    DIR *dir=opendir(path);
    if(!dir) fail(path);
    struct dirent *entry;
    while((entry=readdir(dir))) {
        if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
        char child[PATH_MAX];
        if(snprintf(child,sizeof(child),"%s/%s",path,entry->d_name)>=(int)sizeof(child)) fail(path);
        tree(child,depth+1);
    }
    closedir(dir);
}
static void loader_cache(void) {
    hierarchy("/etc/ld.so.cache");
    FILE *f=fopen("/etc/ld.so.cache","rb");
    if(!f) fail("/etc/ld.so.cache");
    char *data=malloc(4*1024*1024+1);
    if(!data) fail("allocation");
    size_t size=fread(data,1,4*1024*1024+1,f);
    if(size>4*1024*1024 || ferror(f)) fail("loader cache bound");
    fclose(f);
    /* Every cached absolute library pathname is checked, including targets
       outside the ordinary /usr/lib tree used by descendant dynamic loaders. */
    for(size_t i=0;i<size;i++) if(data[i]=='/' && (i==0 || data[i-1]==0)) {
        size_t end=i; while(end<size && data[end]) end++;
        if(end==size || end-i>=PATH_MAX) fail("loader cache path");
        hierarchy(data+i); i=end;
    }
    free(data);
}
int main(int argc,char **argv) {
    if(getuid()!=0 || geteuid()!=0 || argc<2) return 77;
    if(strcmp(argv[1],"serve") && strcmp(argv[1],"setup") && strcmp(argv[1],"repair") && strcmp(argv[1],"uninstall")) return 64;
    if(argc != ((!strcmp(argv[1],"setup")) ? 3 : 2)) return 64;
    if(clearenv() || chdir("/")) return 77;
    hierarchy("/proc/self/exe"); /* /proc symlink has root ownership for root process. */
    tree("/usr/lib/abyssus-helper",0);
    tree("/usr/lib/x86_64-linux-gnu",0);
    hierarchy("/usr/lib/python3/dist-packages");
    tree("/usr/lib/python3/dist-packages/apt",0);
    DIR *modules=opendir("/usr/lib/python3/dist-packages");
    if(!modules) fail("distro apt modules");
    struct dirent *module;
    unsigned native_modules=0;
    while((module=readdir(modules))) {
        size_t length=strlen(module->d_name);
        if((!strncmp(module->d_name,"apt_pkg.",8) || !strncmp(module->d_name,"apt_inst.",9)) && length>3 && !strcmp(module->d_name+length-3,".so")) {
            char file[PATH_MAX]; snprintf(file,sizeof(file),"/usr/lib/python3/dist-packages/%s",module->d_name);
            tree(file,0);native_modules++;
        }
    }
    closedir(modules);
    if(native_modules!=2) fail("unsupported distro apt native modules");
    DIR *lib=opendir("/usr/lib");
    if(!lib) fail("/usr/lib");
    struct dirent *entry;
    while((entry=readdir(lib))) if(!strncmp(entry->d_name,"python3.",8)) {
        char path[PATH_MAX]; snprintf(path,sizeof(path),"/usr/lib/%s",entry->d_name); tree(path,0);
    }
    closedir(lib);
    hierarchy("/usr/bin/python3"); hierarchy("/usr/bin/dpkg");
    hierarchy("/usr/bin/systemctl"); hierarchy("/usr/bin/setfacl");
    hierarchy("/var/lib"); hierarchy("/var/lib/dpkg"); hierarchy("/var/lib/dpkg/status");
    hierarchy("/etc/systemd/system"); hierarchy("/run");
    hierarchy("/lib64/ld-linux-x86-64.so.2");
    loader_cache();
    tree("/usr/lib/apt",0); tree("/etc/apt",0); tree("/etc/dpkg",0);
    hierarchy("/etc/ld.so.conf"); tree("/etc/ld.so.conf.d",0);
    struct stat preload;
    if(!stat("/etc/ld.so.preload",&preload) && preload.st_size) fail("/etc/ld.so.preload unsupported");
    if(!strcmp(argv[1],"serve") || !strcmp(argv[1],"repair") || !strcmp(argv[1],"uninstall")) {
        tree("/etc/abyssus-helper",0); tree("/var/lib/abyssus-helper",0);
    }
    char *env[]={"PATH=/usr/sbin:/usr/bin:/sbin:/bin","HOME=/root","LANG=C.UTF-8",
                 "DEBIAN_FRONTEND=noninteractive","APT_CONFIG=/usr/lib/abyssus-helper/apt.conf",NULL};
    char *args[]={"/lib64/ld-linux-x86-64.so.2","--inhibit-cache","--library-path","/usr/lib/x86_64-linux-gnu",
                  "/usr/bin/python3","-I","-S",
                  !strcmp(argv[1],"serve")?"/usr/lib/abyssus-helper/service.py":"/usr/lib/abyssus-helper/admin.py",
                  argv[1],argc==3?argv[2]:NULL,NULL};
    execve(args[0],args,env);
    return 71;
}
