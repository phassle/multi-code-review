FROM node:24-alpine
WORKDIR /opt/report-store
COPY store.mjs server.mjs ./
# The volume is mounted here; a fresh named volume takes this owner from the image.
RUN mkdir -p /data && chown 1000:1000 /data && chmod 700 /data
USER 1000
EXPOSE 8080
CMD ["node", "server.mjs"]
