# Hauptling worker/test image for einklang: Chrome for the lab sandbox (`npm run lab`).
# Workers have no GPU, so Chrome's WebGPU runs on SwiftShader (bundled with Chrome; the lab falls
# back to it on its own). GPU test jobs (`--gpus all`) get the NVIDIA Vulkan driver from the
# container toolkit; NVIDIA_DRIVER_CAPABILITIES must include graphics for that.
ARG BASE=hauptling-worker
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends wget gnupg ca-certificates libvulkan1 mesa-vulkan-drivers fonts-dejavu-core \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME=/usr/bin/google-chrome-stable NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
