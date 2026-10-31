# Sandbox image for the data-analyst example: pandas + matplotlib, no network
# needed at run time. Build:  docker build -t pal-analyst:dev examples/data-analyst
FROM python:3.12-slim
RUN pip install --no-cache-dir pandas==2.2.3 matplotlib==3.9.2 \
 && useradd -m -u 1000 analyst && mkdir /workspace && chown analyst /workspace
COPY analyze.py /opt/analyze.py
USER analyst
WORKDIR /workspace
# Long-lived sandbox: the control plane execs into it (exec / ExecTool).
CMD ["sleep", "infinity"]
