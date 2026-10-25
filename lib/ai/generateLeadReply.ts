// lib/ai/generateLeadReply.ts

import type {
  ExtractedLeadData,
} from "./extractLeadData";
import {
  resolveBookingRequirements,
} from "@/lib/booking/bookingRequirements";

type GenerateLeadReplyInput = {
  message: string;

  qualification: ExtractedLeadData;
};

function getServiceLabel(
  serviceType: string
) {

  if (
    serviceType === "hvac"
  ) {
    return "HVAC";
  }

  if (
    serviceType ===
    "roofing"
  ) {
    return "roofing";
  }

  if (
    serviceType ===
    "plumbing"
  ) {
    return "plumbing";
  }

  if (
    serviceType ===
    "electrical"
  ) {
    return "electrical";
  }

  return "service";
}

function getOpeningLine(
  qualification:
    ExtractedLeadData
) {

  const service =
    getServiceLabel(
      qualification.serviceType
    );

  // =====================================================
  // EMERGENCY
  // =====================================================

  if (
    qualification.urgency ===
    "emergency"
  ) {

    return (
      `thanks for reaching out — ` +
      `this sounds urgent. ` +
      `We can help with your ${service} issue right away.`
    );
  }

  // =====================================================
  // HIGH PRIORITY
  // =====================================================

  if (
    qualification.urgency ===
    "high"
  ) {

    return (
      `thanks for reaching out — ` +
      `we can likely help with your ${service} issue quickly.`
    );
  }

  // =====================================================
  // NORMAL
  // =====================================================

  return (
    `thanks for reaching out — ` +
    `we can help with your ${service} request.`
  );
}

function getSpeedLine(
  qualification:
    ExtractedLeadData
) {

  const preferred =
    qualification.preferredTime;

  if (
    preferred === "today"
  ) {
    return (
      "We can check availability for today."
    );
  }

  if (
    preferred ===
    "tomorrow morning"
  ) {
    return (
      "We can check availability for tomorrow morning."
    );
  }

  if (
    preferred ===
    "tomorrow afternoon"
  ) {
    return (
      "We can check availability for tomorrow afternoon."
    );
  }

  if (
    preferred ===
    "tomorrow evening"
  ) {
    return (
      "We can check availability for tomorrow evening."
    );
  }

  if (
    preferred ===
    "tomorrow"
  ) {
    return (
      "We can check availability for tomorrow."
    );
  }

  if (
    qualification.urgency ===
      "high" ||
    qualification.urgency ===
      "emergency"
  ) {

    return (
      "We can look for the soonest available appointment."
    );
  }

  return (
    "We can help find a time that works."
  );
}

function getNeededInfoLine(
  qualification:
    ExtractedLeadData
) {

  const requirements =
    resolveBookingRequirements({
      customerName:
        qualification.customerName,
      phone:
        qualification.phone,
      address:
        qualification.location
          ?.address,
      city:
        qualification.location
          ?.city,
      state:
        qualification.location
          ?.state,
      zip:
        qualification.location
          ?.zip,
    });

  const needsName =
    requirements.missing.includes(
      "contact_name"
    );

  const needsPhone =
    requirements.missing.includes(
      "callback_phone"
    );

  const needsAddress =
    requirements.missing.includes(
      "service_address"
    );

  // =====================================================
  // NEED NAME + PHONE + SERVICE ADDRESS
  // =====================================================

  if (
    needsName &&
    needsPhone &&
    needsAddress
  ) {

    return (
      "Before I can confirm an appointment, I need your name, your best callback number, and the full service address (house/home street address, plus apartment, unit, or suite number if applicable)."
    );
  }

  // =====================================================
  // NEED NAME + PHONE
  // =====================================================

  if (
    needsName &&
    needsPhone
  ) {

    return (
      "Before I can confirm an appointment, I need your name and your best callback number."
    );
  }

  // =====================================================
  // NEED NAME + SERVICE ADDRESS
  // =====================================================

  if (
    needsName &&
    needsAddress
  ) {

    return (
      "Before I can confirm an appointment, I need your name and the full service address (house/home street address, plus apartment, unit, or suite number if applicable)."
    );
  }

  // =====================================================
  // NEED PHONE + SERVICE ADDRESS
  // =====================================================

  if (
    needsPhone &&
    needsAddress
  ) {

    return (
      "Before I can confirm an appointment, I need your best callback number and the full service address (house/home street address, plus apartment, unit, or suite number if applicable)."
    );
  }

  // =====================================================
  // NEED NAME ONLY
  // =====================================================

  if (
    needsName
  ) {

    return (
      "Before I can confirm an appointment, I need your name."
    );
  }

  // =====================================================
  // NEED PHONE ONLY
  // =====================================================

  if (
    needsPhone
  ) {

    return (
      "Before I can confirm an appointment, I need your best callback number."
    );
  }

  // =====================================================
  // NEED SERVICE ADDRESS ONLY
  // =====================================================

  if (
    needsAddress
  ) {

    return (
      "Before I can confirm an appointment, I need the full service address (house/home street address, plus apartment, unit, or suite number if applicable)."
    );
  }

  // =====================================================
  // HAVE ALL REQUIRED BOOKING INFORMATION
  // =====================================================

  return (
    "We’ll use the contact information provided and follow up shortly."
  );
}

export async function generateLeadReply({
  qualification,
}: GenerateLeadReplyInput) {

  const openingLine =
    getOpeningLine(
      qualification
    );

  const speedLine =
    getSpeedLine(
      qualification
    );

  const neededInfoLine =
    getNeededInfoLine(
      qualification
    );

  return [
    `Hey — ${openingLine}`,

    speedLine,

    neededInfoLine,
  ].join("\n\n");
}