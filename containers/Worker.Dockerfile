# Toolchain base matches the reviewed M28 builder OCI index (Linux amd64 selected).
FROM node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7
# Exact python-apt version from signed Bookworm repositories, image-only dependency.
RUN apt-get update && apt-get install -y --no-install-recommends python3-apt=2.6.0 && python3 -c 'import apt, apt_pkg' && git --version
COPY helper/core.py helper/apt_adapter.py /opt/abyssus-packages/
COPY containers/container-apt.py /opt/abyssus-packages/container-apt.py
COPY helper/apt.conf /usr/lib/abyssus-helper/apt.conf
RUN mkdir -p /usr/lib/abyssus-helper/empty-apt-config /home/worker /cache && chmod 755 /opt/abyssus-packages && touch /var/lib/apt/extended_states
COPY containers/worker-runner.py containers/worker-bridge.py /opt/abyssus-worker/
COPY containers/broker/egress.py /opt/abyssus-worker/broker/egress.py
ENV HOME=/home/worker
# Broker always overrides entrypoint/user/env and resolves the immutable image ID.
CMD ["/usr/bin/sleep", "infinity"]
