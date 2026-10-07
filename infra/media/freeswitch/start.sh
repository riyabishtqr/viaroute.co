#!/bin/sh
# Writes vars.xml from the environment, then starts FreeSWITCH (the image's own entrypoint).
set -e

: "${ESL_PASSWORD:?set ESL_PASSWORD (shared with the media agent)}"
EXTERNAL_IP="${EXTERNAL_IP:-auto-nat}"

mkdir -p /etc/freeswitch/viaroute/acl /etc/freeswitch/viaroute/gateways /recordings
# The agent (another container, not root) writes the trunk files and tidies old recordings.
chmod 0777 /etc/freeswitch/viaroute/acl /etc/freeswitch/viaroute/gateways /recordings
# Until the agent writes the trunk list, nobody is allowed in.
[ -n "$(ls /etc/freeswitch/viaroute/acl 2>/dev/null)" ] || printf '<include>\n  <list name="trunks" default="deny"></list>\n</include>\n' > /etc/freeswitch/viaroute/acl/trunks.xml && chmod 0666 /etc/freeswitch/viaroute/acl/trunks.xml

cat > /etc/freeswitch/vars.xml <<EOF
<include>
  <X-PRE-PROCESS cmd="set" data="esl_password=${ESL_PASSWORD}"/>
  <X-PRE-PROCESS cmd="set" data="esl_listen_ip=${ESL_LISTEN_IP:-127.0.0.1}"/>
  <X-PRE-PROCESS cmd="set" data="esl_allow=${ESL_ALLOW:-127.0.0.1/32}"/>
  <X-PRE-PROCESS cmd="set" data="external_ip=${EXTERNAL_IP}"/>
  <X-PRE-PROCESS cmd="set" data="sip_port=${SIP_PORT:-5060}"/>
  <X-PRE-PROCESS cmd="set" data="rtp_start_port=${RTP_START_PORT:-16384}"/>
  <X-PRE-PROCESS cmd="set" data="rtp_end_port=${RTP_END_PORT:-32768}"/>
  <X-PRE-PROCESS cmd="set" data="max_sessions=${MAX_SESSIONS:-4000}"/>
  <X-PRE-PROCESS cmd="set" data="sessions_per_second=${SESSIONS_PER_SECOND:-100}"/>
  <X-PRE-PROCESS cmd="set" data="tts_voice=${TTS_VOICE:-slt}"/>
  <X-PRE-PROCESS cmd="set" data="log_level=${LOG_LEVEL:-info}"/>
</include>
EOF

exec /entrypoint.sh
