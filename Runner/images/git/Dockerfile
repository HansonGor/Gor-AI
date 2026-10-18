FROM alpine:3.20
RUN apk add --no-cache git \
 && addgroup -g 1000 runner \
 && adduser -D -u 1000 -G runner -h /tmp runner
USER 1000:1000
WORKDIR /work
ENTRYPOINT []
