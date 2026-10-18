#!/usr/bin/env python3
"""Rotating log sink for the supervisor: ``some_command 2>&1 | logpipe.py FILE``.

Appends every line to FILE and rotates it WITHOUT losing a line (the file is renamed and a new one opened by the only writer: no copytruncate
window). Rotated files are gzipped (FILE.YYYYmmdd-HHMMSS.gz) and anything older than LOG_KEEP_DAYS (default 7) is deleted.
  LOG_MAX_BYTES   rotate when FILE would exceed this (default 50 MiB)
  LOG_KEEP_DAYS   retention of rotated files (default 7)
Also rotates when the UTC day changes. Exits when its stdin closes (the command ended).
"""
import glob
import gzip
import os
import shutil
import signal
import sys
import threading
import time

MAX = int(os.environ.get("LOG_MAX_BYTES", 50 * 1024 * 1024))
KEEP_S = float(os.environ.get("LOG_KEEP_DAYS", 7)) * 86400


def day(ts):
    return time.strftime("%Y%m%d", time.gmtime(ts))


def prune(path):
    now = time.time()
    for f in glob.glob(glob.escape(path) + ".2*"):
        try:
            if now - os.path.getmtime(f) > KEEP_S:
                os.remove(f)
        except OSError:
            pass


def compress(src):
    try:
        with open(src, "rb") as i, gzip.open(src + ".gz.tmp", "wb", compresslevel=6) as o:
            shutil.copyfileobj(i, o)
        os.replace(src + ".gz.tmp", src + ".gz")
        os.remove(src)
    except OSError:
        pass


def rotate(path):
    base = f"{path}.{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}"
    dst, n = base, 0
    while os.path.exists(dst) or os.path.exists(dst + ".gz") or os.path.exists(dst + ".gz.tmp"):
        n += 1
        dst = f"{base}-{n}"
    os.rename(path, dst)
    t = threading.Thread(target=lambda: (compress(dst), prune(path)), daemon=False)
    t.start()


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: logpipe.py FILE")
    path = sys.argv[1]
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    prune(path)
    try:
        st = os.stat(path)
        if st.st_size > 0 and (st.st_size >= MAX or day(st.st_mtime) != day(time.time())):
            rotate(path)
    except FileNotFoundError:
        pass
    f = open(path, "ab", buffering=0)
    size, cur_day, last_prune = f.tell(), day(time.time()), time.time()
    for line in sys.stdin.buffer:
        now = time.time()
        if size > 0 and (size + len(line) > MAX or day(now) != cur_day):
            f.close()
            rotate(path)
            f = open(path, "ab", buffering=0)
            size, cur_day = 0, day(now)
        if now - last_prune > 3600:
            last_prune = now
            prune(path)
        f.write(line)
        size += len(line)
    f.close()


if __name__ == "__main__":
    main()
