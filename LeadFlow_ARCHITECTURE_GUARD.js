
const fs = require('fs');
const path = require('path');

const root = process.cwd();
let failures = 0;

function pass(msg) {
  console.log(`PASS ${msg}`);
}

function fail(msg) {
  failures++;
  console.error(`FAIL ${msg}`);
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function read(rel) {
  return exists(rel)
    ? fs.readFileSync(path.join(root, rel), 'utf8')
    : '';
}

function requireFile(rel) {
  if (exists(rel)) {
    pass(`required file exists: ${rel}`);
  } else {
    fail(`required file missing: ${rel}`);
  }
}

function mustContain(rel, token) {
  const s = read(rel);

  if (s.includes(token)) {
    pass(`${rel} contains ${token}`);
  } else {
    fail(`${rel} missing ${token}`);
  }
}

function mustNotContain(rel, token) {
  const s = read(rel);

  if (!s.includes(token)) {
    pass(`${rel} excludes ${token}`);
  } else {
    fail(`${rel} contains forbidden token ${token}`);
  }
}

function before(rel, a, b) {
  const s = read(rel);
  const ia = s.indexOf(a);
  const ib = s.indexOf(b);

  return ia >= 0 && ib >= 0 && ia < ib;
}

const required = [
  'lib/booking/resolveBookingCommand.ts',
  'lib/ai/resolveSchedulingIntent.ts',
  'lib/scheduling/resolveCanonicalTemporalIntent.ts',
  'lib/availability/checkAvailability.ts',
  'lib/google/createCalendarBooking.ts',
  'lib/gmail/processGmailPubSubWebhook.ts',
  'lib/inbound/processInboundEmail.ts',
  'lib/jobs/processProspectInquiryJob.ts',
  'lib/background-jobs/claimBackgroundJob.ts',
  'lib/background-jobs/completeBackgroundJob.ts',
  'lib/background-jobs/enqueueBackgroundJob.ts',
  'lib/background-jobs/failBackgroundJob.ts',
  'lib/background-jobs/jobReliability.ts',
  'lib/background-jobs/updateBackgroundJobHeartbeat.ts',
  'workers/leadflowWorker.ts',
];

required.forEach(requireFile);

const forbiddenFiles = [
  'lib/ai/resolveAvailabilityInquiryIntent.ts',
  'lib/ai/resolveCustomerActionIntent.ts',
  'app/api/customer-replies/process/route.ts',
  'lib/ai/extractCustomerReplyIntent.ts',
  'lib/calendar/bookAppointment.ts',
  'lib/background-jobs/backgroundQueues.ts',
  'lib/background-jobs/backgroundWorker.ts',
  'lib/background-jobs/redisConnection.ts',
  'scripts/start-background-worker.ts',
  'lib/queue.ts',
  'lib/queue/createJob.ts',
  'lib/queueTypes.ts',
  'lib/worker.ts',
  'lib/jobRunner.ts',
  'scripts/start-worker.ts',
  'lib/workflow/runner.ts',
  'lib/workflow/context.ts',
  'lib/queue/redis.ts',
  'lib/queue/jobs.ts',
  'lib/queue/queues.ts',
  'lib/queue/enqueue.ts',
];

for (const rel of forbiddenFiles) {
  if (exists(rel)) {
    fail(`legacy production file still exists: ${rel}`);
  } else {
    pass(`legacy file absent: ${rel}`);
  }
}

mustContain(
  'lib/booking/resolveBookingCommand.ts',
  'ONE authoritative booking-domain action resolver'
);

mustContain(
  'lib/booking/resolveBookingCommand.ts',
  'verifyMutationAuthorization'
);

mustNotContain(
  'lib/inbound/processInboundEmail.ts',
  'resolveCustomerActionIntent'
);

mustNotContain(
  'lib/inbound/processInboundEmail.ts',
  'resolveAvailabilityInquiryIntent'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'resolveBookingCommand'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'toLegacyCustomerActionIntent(bookingCommand)'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'toLegacyAvailabilityIntent(bookingCommand)'
);

mustContain(
  'lib/gmail/processGmailPubSubWebhook.ts',
  'authoritative_exact_booking_thread_owner'
);

mustNotContain(
  'lib/gmail/processGmailPubSubWebhook.ts',
  'shouldForceBookingConversation'
);

if (
  before(
    'lib/gmail/processGmailPubSubWebhook.ts',
    'if (activeBookingOwnsExactThread && activeBookingConversation)',
    'const customerAdmission = await classifyInboundCustomerIntent'
  )
) {
  pass('exact booking conversation ownership precedes semantic admission');
} else {
  fail('exact booking conversation ownership must precede semantic admission');
}

mustContain(
  'lib/gmail/processGmailPubSubWebhook.ts',
  'claimInboundRoutingOwnership'
);

mustContain(
  'lib/gmail/processGmailPubSubWebhook.ts',
  'exact prospect thread retained before sender booking fallback'
);

mustContain(
  'lib/gmail/processGmailPubSubWebhook.ts',
  'prospect_route_routed_without_queued_job'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'trustedProspectBookingHandoff'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'fetchPromotedLeadForProspectBookingHandoff'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'prospect_booking_handoff_missing_provider_event_id'
);

mustContain(
  'lib/jobs/processProspectInquiryJob.ts',
  'buildProspectBookingHandoffEventId'
);

mustContain(
  'lib/jobs/processProspectInquiryJob.ts',
  'assertPromotedProspectReadyForBookingHandoff'
);

mustContain(
  'lib/ai/resolveSchedulingIntent.ts',
  'SchedulingTemporalOperation'
);

mustContain(
  'lib/scheduling/resolveCanonicalTemporalIntent.ts',
  'selected_offer'
);

mustContain(
  'lib/scheduling/resolveCanonicalTemporalIntent.ts',
  'active_appointment'
);

mustContain(
  'lib/scheduling/resolveCanonicalTemporalIntent.ts',
  'operationHasLiteralSupport'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'activeAppointmentTime:'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'resolveCanonicalTemporalIntent({'
);

for (
  const token of [
    'previous_occurrence',
    'next_occurrence',
    'current_week',
    'previous_week',
    'next_week',
    'week_before_last',
    'week_after_next',
  ]
) {
  mustContain(
    'lib/inbound/processInboundEmail.ts',
    token
  );
}

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'answerBookedCustomerInformationRequest'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'mixed_customer_intelligence_mutated_booking_truth'
);

mustContain(
  'lib/jobs/processProspectInquiryJob.ts',
  'requiresFreshExternalData'
);

mustContain(
  'lib/jobs/processProspectInquiryJob.ts',
  'answerCompanyQuestionWithOfficialWeb'
);

mustContain(
  'lib/google/createCalendarBooking.ts',
  '@/lib/availability/checkAvailability'
);

mustContain(
  'lib/availability/checkAvailability.ts',
  'getCompanyCalendarClient'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'suggestAlternativeSlots'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'createCalendarBooking'
);

for (
  const token of [
    'restore_cancelled',
    'restore_previous',
    'restore_original',
    'cancel',
    'reschedule',
  ]
) {
  mustContain(
    'lib/inbound/processInboundEmail.ts',
    token
  );
}

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'pendingBookingConfirmation'
);

mustContain(
  'lib/inbound/processInboundEmail.ts',
  'pendingBookingClarification'
);

for (
  const token of [
    'claimBackgroundJob',
    'completeBackgroundJob',
    'failBackgroundJob',
    'process_prospect_inquiry',
  ]
) {
  mustContain(
    'workers/leadflowWorker.ts',
    token
  );
}

const pkg = read('package.json');

for (
  const token of [
    'start-background-worker',
    'scripts/start-worker',
    'lib/jobRunner',
    'lib/worker',
  ]
) {
  if (pkg.includes(token)) {
    fail(`package.json contains legacy worker reference: ${token}`);
  } else {
    pass(`package.json excludes legacy worker reference: ${token}`);
  }
}

console.log('\nLeadFlow architecture guard complete.');

if (failures) {
  console.error(`${failures} architecture violation(s) found.`);
  process.exit(1);
}

console.log('ALL ARCHITECTURE GUARDS PASSED');
