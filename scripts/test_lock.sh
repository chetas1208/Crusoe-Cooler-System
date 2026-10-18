# Sourced by scripts/test_fast.sh / test_all.sh: take ONE of the PYTEST_SLOTS (default 3) shared with scripts/pytest_locked.sh
# (same /tmp/loopkeeper-pytest.<n>.lock files, same polling), then return with fd 9 held. Skipped when LOOPKEEPER_LOCK_HELD=1.
if [ "${LOOPKEEPER_LOCK_HELD:-0}" != "1" ]; then
  _SLOTS=${PYTEST_SLOTS:-3}
  while true; do
    for _i in $(seq 1 "$_SLOTS"); do
      exec 9>"/tmp/loopkeeper-pytest.$_i.lock"
      if flock -n 9; then break 2; fi
      exec 9>&-
    done
    sleep 2
  done
fi
