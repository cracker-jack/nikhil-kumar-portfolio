FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node assets/booking-slots.js assets/booking-slots.js
COPY --chown=node:node integrations/razorpay/payment-model.mjs integrations/razorpay/payment-model.mjs
COPY --chown=node:node integrations/razorpay/api-client.mjs integrations/razorpay/api-client.mjs
COPY --chown=node:node integrations/calendar/google-oauth.mjs integrations/calendar/google-oauth.mjs
COPY --chown=node:node integrations/calendar/availability.mjs integrations/calendar/availability.mjs
COPY --chown=node:node integrations/calendar/booking-service.mjs integrations/calendar/booking-service.mjs
COPY --chown=node:node integrations/calendar/availability-server.mjs integrations/calendar/availability-server.mjs
USER node
ENV NODE_ENV=production
CMD ["node", "integrations/calendar/availability-server.mjs"]
