import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'agent_v2_' });

export const taskTransitions = new Counter({
  name: 'agent_v2_task_transitions_total',
  help: 'Total task state transitions.',
  labelNames: ['from', 'to'],
  registers: [metricsRegistry],
});

export const taskDuration = new Histogram({
  name: 'agent_v2_task_duration_seconds',
  help: 'End-to-end task execution duration.',
  labelNames: ['status', 'executor'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900],
  registers: [metricsRegistry],
});

export const queueDepth = new Gauge({
  name: 'agent_v2_queue_depth',
  help: 'Current BullMQ waiting plus delayed job count.',
  registers: [metricsRegistry],
});

export const policyDecisions = new Counter({
  name: 'agent_v2_policy_decisions_total',
  help: 'Policy decisions by outcome.',
  labelNames: ['outcome'],
  registers: [metricsRegistry],
});
