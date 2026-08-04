FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Use NOOA_PACKAGE to pin a release or a specific fork, for example:
# docker build --build-arg NOOA_PACKAGE='git+https://github.com/Daedu86/labs-OO-Agents.git' -t nodes-nooa:local .
ARG NOOA_PACKAGE=nooa
RUN pip install --no-cache-dir "${NOOA_PACKAGE}"

WORKDIR /sandbox
