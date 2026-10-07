# ViaRoute media server: FreeSWITCH 1.11 (SIP, G.711, flite TTS, MP3 recording) with ViaRoute's config.
FROM safarov/freeswitch:latest
COPY conf/ /etc/freeswitch/
COPY start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /etc/freeswitch/viaroute/acl /etc/freeswitch/viaroute/gateways /recordings
ENTRYPOINT ["/start.sh"]
