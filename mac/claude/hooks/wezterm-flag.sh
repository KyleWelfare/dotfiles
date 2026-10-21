#!/bin/bash
# Sets the WezTerm user var claude_waiting on this session's pane (2 = working, 1 = needs you, 0 = clear).
# Hooks have no controlling tty, so write to the nearest ancestor's tty (the claude process).
pid=$PPID
while [ "${pid:-1}" -gt 1 ]; do
  t=$(ps -o tty= -p "$pid" | tr -d ' ')
  [ -n "$t" ] && [ "$t" != "??" ] && break
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
[ -n "$t" ] && [ "$t" != "??" ] || exit 0
printf '\033]1337;SetUserVar=claude_waiting=%s\007' "$(printf %s "$1" | base64)" > "/dev/$t"
