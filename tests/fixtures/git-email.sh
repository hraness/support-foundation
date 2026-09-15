#!/bin/sh
# Static synthetic Git fixture. Configuration is data passed in the environment.
case "$SUPPORT_TEST_GIT_MODE" in
  count)
    printf '%s\n' "$@" >> "$SUPPORT_TEST_GIT_LOG"
    printf '%s\n' "$SUPPORT_TEST_GIT_EMAIL"
    ;;
  stall)
    exec "$SUPPORT_TEST_RUNTIME" "$SUPPORT_TEST_SCRIPT"
    ;;
  oversize)
    printf '%02048d@example.com\n' 0
    ;;
  *) exit 1 ;;
esac
