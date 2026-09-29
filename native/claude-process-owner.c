#if defined(__linux__)
#define _POSIX_C_SOURCE 200809L
#endif
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif
#if defined(__APPLE__)
#include <libproc.h>
#include <pthread.h>
#include <sys/event.h>
#endif
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/*
 * Own one dedicated Claude CLI and its OS descendants, including tools that
 * call setsid(). No Task state, protocol parsing, process-name matching or
 * shared-daemon discovery belongs here. Kernel child custody is the authority.
 * Keep this supervisor alive until waitpid proves every adopted child exited;
 * macOS reports an unconfirmed fork where kernel adoption is unavailable.
 *
 * Linux uses a child subreaper (PR_SET_CHILD_SUBREAPER): orphaned descendants
 * are reparented here and enumerated through /proc. macOS has no subreaper, so
 * currently linked descendants are enumerated through libproc and signalled
 * deepest-first; the parent-death signal is emulated by watching for
 * reparenting to PID 1. A detached orphan can escape that scan, so a root
 * fork makes a successful cleanup result unprovable.
 */
static volatile sig_atomic_t stopping = 0;
#if defined(__APPLE__)
static pid_t root_process = 0;
static int fork_events = -1;
static bool root_forked = false;
#endif

static void request_stop(int signal_number) {
  stopping = signal_number;
}

static long long monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) < 0) {
    perror("Claude owner clock");
    exit(125);
  }
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

#if defined(__linux__)
static int signal_children(int signal_number) {
  char path[96];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  FILE *children = fopen(path, "r");
  if (children == NULL) return -1;
  long pid;
  int result = 0;
  while (fscanf(children, "%ld", &pid) == 1) {
    /*
     * Only our unreaped direct children are listed. This process is the sole
     * waiter, so their PIDs cannot be reused between this read and kill().
     * Killing a parent causes its remaining children to be adopted here.
     */
    if (pid > 0 && kill((pid_t)pid, signal_number) < 0 && errno != ESRCH) result = -1;
  }
  if (ferror(children)) result = -1;
  fclose(children);
  return result;
}
#elif defined(__APPLE__)

struct descendant_entry {
  pid_t pid;
  unsigned depth;
  uint64_t start_seconds;
  uint64_t start_microseconds;
};

/*
 * Collects every live descendant of ancestor_pid using parent-PID links from
 * libproc (the macOS equivalent of walking /proc/<pid>/stat ppid fields).
 */
static int collect_descendants(pid_t ancestor_pid,
                               struct descendant_entry **entries_out,
                               size_t *count_out) {
  int buffer_size = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (buffer_size <= 0) return -1;
  pid_t *pids = NULL;
  struct proc_bsdinfo *processes = NULL;
  struct descendant_entry *frontier = NULL;
  struct descendant_entry *entries = NULL;
  int result = -1;
  for (;;) {
    pids = malloc((size_t)buffer_size);
    if (pids == NULL) goto done;
    int returned = proc_listpids(PROC_ALL_PIDS, 0, pids, buffer_size);
    if (returned < 0) goto done;
    if (returned <= buffer_size) {
      buffer_size = returned;
      break;
    }
    free(pids);
    pids = NULL;
    buffer_size = returned;
  }
  size_t process_count = (size_t)buffer_size / sizeof(pid_t);
  processes = calloc(process_count, sizeof(*processes));
  frontier = calloc(process_count, sizeof(*frontier));
  entries = calloc(process_count, sizeof(*entries));
  if (processes == NULL || frontier == NULL || entries == NULL) goto done;
  size_t live_count = 0;
  uid_t owner_uid = geteuid();
  for (size_t index = 0; index < process_count; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 1) continue;
    struct proc_bsdinfo info;
    int info_size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, (int)sizeof(info));
    if (info_size < (int)sizeof(info)) continue;
    /* Every descendant of this supervisor runs under the same user. */
    if ((uid_t)info.pbi_uid != owner_uid) continue;
    processes[live_count] = info;
    live_count += 1;
  }
  size_t frontier_count = 0;
  frontier[frontier_count++] = (struct descendant_entry){ .pid = ancestor_pid, .depth = 0 };
  size_t entry_count = 0;
  for (size_t cursor = 0; cursor < frontier_count; cursor += 1) {
    struct descendant_entry current = frontier[cursor];
    for (size_t index = 0; index < live_count; index += 1) {
      if ((pid_t)processes[index].pbi_ppid != current.pid) continue;
      pid_t child_pid = (pid_t)processes[index].pbi_pid;
      bool already_seen = false;
      for (size_t seen = 0; seen < frontier_count; seen += 1) {
        if (frontier[seen].pid == child_pid) { already_seen = true; break; }
      }
      if (already_seen) continue;
      struct descendant_entry child = {
        .pid = child_pid, .depth = current.depth + 1,
        .start_seconds = processes[index].pbi_start_tvsec,
        .start_microseconds = processes[index].pbi_start_tvusec
      };
      if (frontier_count < process_count) frontier[frontier_count++] = child;
      if (child.depth > 0) entries[entry_count++] = child;
    }
  }
  *entries_out = entries;
  entries = NULL;
  *count_out = entry_count;
  result = 0;
done:
  free(pids);
  free(processes);
  free(frontier);
  free(entries);
  return result;
}

static int descendant_compare(const void *left, const void *right) {
  const struct descendant_entry *a = left;
  const struct descendant_entry *b = right;
  if (a->depth != b->depth) return a->depth < b->depth ? 1 : -1;
  return a->pid < b->pid ? 1 : a->pid > b->pid ? -1 : 0;
}

/*
 * Signals the whole tree rooted here, deepest first, so children are signalled
 * before their parents and cannot escape through reparenting in the same sweep.
 */
static int signal_children(int signal_number) {
  struct descendant_entry *entries = NULL;
  size_t count = 0;
  if (collect_descendants(getpid(), &entries, &count) < 0) return -1;
  qsort(entries, count, sizeof(*entries), descendant_compare);
  int result = 0;
  for (size_t index = 0; index < count; index += 1) {
    struct proc_bsdinfo current;
    if (proc_pidinfo(entries[index].pid, PROC_PIDTBSDINFO, 0,
                     &current, (int)sizeof(current)) != (int)sizeof(current)) {
      result = -1;
      continue;
    }
    if (current.pbi_start_tvsec != entries[index].start_seconds
        || current.pbi_start_tvusec != entries[index].start_microseconds) continue;
    if (kill(entries[index].pid, signal_number) < 0 && errno != ESRCH) result = -1;
  }
  /*
   * The root leads its own process group: this also reaches descendants that
   * escaped the parent-PID tree through reparenting but never called setsid().
   * Detached descendants may evade both checks; fork observation below
   * prevents a false successful cleanup report in that case.
   */
  if (root_process > 0 && killpg(root_process, signal_number) < 0
      && errno != ESRCH && errno != EPERM) {
    result = -1;
  }
  free(entries);
  return result;
}

static void *watch_parent(void *unused) {
  (void)unused;
  const struct timespec pause = { .tv_sec = 0, .tv_nsec = 100 * 1000 * 1000 };
  for (;;) {
    nanosleep(&pause, NULL);
    /* When the original parent exits, an orphan is reparented to PID 1. */
    if (getppid() == 1) {
      /*
       * Send to the whole process rather than raising on this thread: the
       * termination signals are blocked here, so the kernel delivers this to
       * the main thread, interrupting its waitpid on the first sweep.
       */
      kill(getpid(), SIGTERM);
      return NULL;
    }
  }
}

static int observe_root_forks(void) {
  struct kevent event;
  const struct timespec now = { .tv_sec = 0, .tv_nsec = 0 };
  for (;;) {
    int count = kevent(fork_events, NULL, 0, &event, 1, &now);
    if (count < 0) return -1;
    if (count == 0) return 0;
    if ((event.fflags & NOTE_FORK) != 0) root_forked = true;
  }
}
#endif

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("Usage: claude-process-owner <executable> [arguments...]\n", stderr);
    return 125;
  }
  struct sigaction action = {0};
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) < 0
      || sigaction(SIGINT, &action, NULL) < 0
      || sigaction(SIGHUP, &action, NULL) < 0
#if defined(__linux__)
      || prctl(PR_SET_CHILD_SUBREAPER, 1L, 0L, 0L, 0L) < 0
#endif
  ) {
    perror("Claude process ownership");
    return 125;
  }
  pid_t parent = getppid();
#if defined(__linux__)
  if (prctl(PR_SET_PDEATHSIG, (long)SIGTERM, 0L, 0L, 0L) < 0) {
    perror("Claude parent-death signal");
    return 125;
  }
#elif defined(__APPLE__)
  /*
   * Block the termination signals in this thread before spawning the watcher:
   * the new thread inherits the mask, guaranteeing a process-directed
   * parent-death SIGTERM is delivered to the main thread (which restores its
   * own mask below) and interrupts its blocking waitpid.
   */
  sigset_t blocked_signals;
  sigemptyset(&blocked_signals);
  sigaddset(&blocked_signals, SIGTERM);
  sigaddset(&blocked_signals, SIGINT);
  sigaddset(&blocked_signals, SIGHUP);
  if (pthread_sigmask(SIG_BLOCK, &blocked_signals, NULL) != 0) {
    perror("Claude owner signal mask");
    return 125;
  }
  pthread_t parent_watcher;
  if (pthread_create(&parent_watcher, NULL, watch_parent, NULL) != 0) {
    perror("Claude parent watcher");
    return 125;
  }
  pthread_detach(parent_watcher);
  if (pthread_sigmask(SIG_UNBLOCK, &blocked_signals, NULL) != 0) {
    perror("Claude owner signal mask");
    return 125;
  }
#endif
  if (parent == 1 || getppid() != parent) return 125;
#if defined(__APPLE__)
  /* Register the root's fork notification before it can exec or fork. */
  int start_gate[2];
  if (pipe(start_gate) < 0) return 125;
#endif
  pid_t root = fork();
  if (root < 0) {
    perror("Claude owner fork");
    return 125;
  }
  if (root == 0) {
#if defined(__APPLE__)
    close(start_gate[1]);
    char gate_byte;
    while (read(start_gate[0], &gate_byte, 1) < 0 && errno == EINTR) {}
    close(start_gate[0]);
#endif
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
#if defined(__APPLE__)
    if (setpgid(0, 0) < 0) {
      perror("Claude owner process group");
      _exit(127);
    }
#endif
    execvp(argv[1], &argv[1]);
    perror("Claude executable");
    _exit(127);
  }
#if defined(__APPLE__)
  root_process = root;
  close(start_gate[0]);
  fork_events = kqueue();
  struct kevent root_event;
  EV_SET(&root_event, root, EVFILT_PROC, EV_ADD | EV_CLEAR,
         NOTE_FORK | NOTE_EXIT, 0, NULL);
  if (fork_events < 0
      || kevent(fork_events, &root_event, 1, NULL, 0, NULL) < 0) {
    kill(root, SIGKILL);
    close(start_gate[1]);
    waitpid(root, NULL, 0);
    return 125;
  }
  close(start_gate[1]);
#endif
  bool root_ended = false, warned = false;
  int root_status = 0;
  long long stop_started = 0;
  for (;;) {
#if defined(__APPLE__)
    if (observe_root_forks() < 0) {
      fputs("Claude descendant fork observation failed; cleanup is unconfirmed.\n", stderr);
      return 125;
    }
#endif
    bool draining = stopping != 0 || root_ended;
    if (draining) {
      if (stop_started == 0) stop_started = monotonic_ms();
      int signal_number = monotonic_ms() - stop_started < 1000 ? SIGTERM : SIGKILL;
      if (signal_children(signal_number) < 0 && !warned) {
        fputs("Claude descendant cleanup is unconfirmed; retaining process ownership.\n", stderr);
        warned = true;
      }
    }
    int status;
    /*
     * Linux: the subreaper reparents every orphan here, so waitpid(-1) owns
     * the whole tree. macOS: only the root child is ever ours, so wait for it
     * directly and rely on libproc sweeps for the rest of the tree.
     */
#if defined(__linux__)
    pid_t child = waitpid(-1, &status, draining ? WNOHANG : 0);
#else
    pid_t child = root_ended ? -1 : waitpid(root, &status, WNOHANG);
    if (child < 0 && root_ended) errno = ECHILD;
#endif
    if (child > 0) {
      if (child == root) {
        root_ended = true;
        root_status = status;
#if defined(__APPLE__)
        /* waitpid released this PID; it can no longer authorize group signals. */
        root_process = 0;
#endif
      }
      continue;
    }
    if (child < 0) {
      if (errno == EINTR) continue;
      if (errno == ECHILD) {
#if defined(__APPLE__)
        /* Exit only once the enumerated descendant tree is gone. */
        if (root_ended) {
          struct descendant_entry *entries = NULL;
          size_t remaining = 0;
          if (collect_descendants(getpid(), &entries, &remaining) < 0
              || remaining > 0) {
            free(entries);
            const struct timespec short_pause = { .tv_sec = 0, .tv_nsec = 20000000 };
            nanosleep(&short_pause, NULL);
            continue;
          }
          free(entries);
        }
#endif
        break;
      }
      perror("Claude owner wait");
      return 125;
    }
#if defined(__APPLE__)
    /* Drain completed: root exited and no descendant remains. */
    if (root_ended) {
      struct descendant_entry *entries = NULL;
      size_t remaining = 0;
      if (collect_descendants(getpid(), &entries, &remaining) == 0
          && remaining == 0) {
        free(entries);
        break;
      }
      free(entries);
    }
#endif
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 20000000 };
    nanosleep(&pause, NULL);
  }
  if (!root_ended) return 125;
#if defined(__APPLE__)
  /* macOS cannot adopt a forked process after setsid + reparenting. A clear
   * parent tree and process group do not prove its exit. Keep that uncertainty
   * visible instead of returning the root's successful status as cleanup. */
  if (root_forked) {
    fputs("Claude descendant cleanup is unconfirmed after a fork on macOS.\n", stderr);
    return 125;
  }
  close(fork_events);
#endif
  return WIFEXITED(root_status) ? WEXITSTATUS(root_status)
    : WIFSIGNALED(root_status) ? 128 + WTERMSIG(root_status) : 125;
}
