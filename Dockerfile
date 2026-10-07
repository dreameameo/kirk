FROM node:22-alpine
ENV NODE_ENV=production KERK_CONFIG=/data/config.json
WORKDIR /app
COPY src ./src
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/kerk.js"]
