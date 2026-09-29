#include <errno.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <libproc.h>
#include <sys/sysctl.h>
#endif

/* Print a kernel process-generation token. A PID alone is never an identity. */
#if defined(__APPLE__)
static bool inspect_controller(pid_t pid, struct proc_bsdinfo *identity,
                               char **home_out) {
  struct proc_bsdinfo before;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, (int)sizeof(before))
      != (int)sizeof(before) || before.pbi_uid != geteuid()) return false;
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0 || size < sizeof(int)) return false;
  char *buffer = malloc(size);
  if (buffer == NULL) return false;
  bool matched = false;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size < sizeof(int)) goto done;
  int argc;
  memcpy(&argc, buffer, sizeof(argc));
  if (argc < 1 || argc > 1024) goto done;
  size_t cursor = sizeof(argc);
  while (cursor < size && buffer[cursor] != '\0') cursor++;
  while (cursor < size && buffer[cursor] == '\0') cursor++;
  bool entrypoint = false;
  for (int arg = 0; arg < argc && cursor < size; arg++) {
    const char *value = buffer + cursor;
    size_t length = strnlen(value, size - cursor);
    if (length == size - cursor) goto done;
    if ((length == strlen("controllerMain.js")
         && strcmp(value, "controllerMain.js") == 0)
        || (length >= strlen("/controllerMain.js")
            && strcmp(value + length - strlen("/controllerMain.js"),
                      "/controllerMain.js") == 0)) entrypoint = true;
    cursor += length + 1;
  }
  if (!entrypoint) goto done;
  while (cursor < size && buffer[cursor] == '\0') cursor++;
  for (; cursor < size;) {
    const char *value = buffer + cursor;
    size_t length = strnlen(value, size - cursor);
    if (length == size - cursor) goto done;
    if (length > strlen("YUI_HOME=") && strncmp(value, "YUI_HOME=", 9) == 0) {
      const char *home = value + 9;
      if (strchr(home, '\n') != NULL || strchr(home, '\t') != NULL) goto done;
      *home_out = strdup(home);
      matched = *home_out != NULL;
      break;
    }
    cursor += length + 1;
  }
  if (!matched) goto done;
  struct proc_bsdinfo after;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &after, (int)sizeof(after))
      != (int)sizeof(after)
      || before.pbi_start_tvsec != after.pbi_start_tvsec
      || before.pbi_start_tvusec != after.pbi_start_tvusec) {
    free(*home_out);
    *home_out = NULL;
    matched = false;
  } else {
    *identity = after;
  }
done:
  free(buffer);
  return matched;
}
#endif

int main(int argc, char **argv) {
#if defined(__APPLE__)
  if (argc == 2 && strcmp(argv[1], "--controllers") == 0) {
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (bytes <= 0) return 2;
    bytes += (int)(64 * sizeof(pid_t));
    pid_t *pids = malloc((size_t)bytes);
    if (pids == NULL) return 2;
    int used = proc_listpids(PROC_ALL_PIDS, 0, pids, bytes);
    if (used < 0) { free(pids); return 2; }
    for (int i = 0; i < used / (int)sizeof(pid_t); i++) {
      struct proc_bsdinfo identity;
      char *home = NULL;
      if (inspect_controller(pids[i], &identity, &home)) {
        printf("%u\t%llu\t%s\n", identity.pbi_pid,
          (unsigned long long)(identity.pbi_start_tvsec * 1000000ULL
            + identity.pbi_start_tvusec), home);
        free(home);
      }
    }
    free(pids);
    return 0;
  }
#endif
  bool controller = argc == 3 && strcmp(argv[1], "--controller") == 0;
  if (argc != 2 && !controller) return 2;
  char *end = NULL;
  errno = 0;
  const char *pid_text = controller ? argv[2] : argv[1];
  long value = strtol(pid_text, &end, 10);
  if (errno != 0 || end == pid_text || *end != '\0' || value <= 0) return 2;
#if defined(__APPLE__)
  if (controller) {
    struct proc_bsdinfo identity;
    char *home = NULL;
    if (!inspect_controller((pid_t)value, &identity, &home)) return 1;
    printf("%u\t%llu\t%s\n", identity.pbi_pid,
      (unsigned long long)(identity.pbi_start_tvsec * 1000000ULL
        + identity.pbi_start_tvusec), home);
    free(home);
    return 0;
  }
  struct proc_bsdinfo info;
  int size = proc_pidinfo((pid_t)value, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
  if (size != (int)sizeof(info) || info.pbi_pid != (uint32_t)value) return 1;
  printf("%llu\n", (unsigned long long)(info.pbi_start_tvsec * 1000000ULL
    + info.pbi_start_tvusec));
  return 0;
#else
  (void)value;
  return 2;
#endif
}
