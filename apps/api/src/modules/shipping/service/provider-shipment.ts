import type { ParcelKind } from "@navet/shared";
import type { ProviderShipment } from "./freight-provider.js";
import type { SenderParty } from "./freight-settings.service.js";

// The broker payload — pure (no DB imports). Shared by the försändelse
// (shipment rows + parcel rows) and the price probe on an offert/kundorder
// (resolved recipient + parcels straight from the request), so the two can
// never describe the same shipment differently to Sendify.

export interface RecipientPartyFields {
  recipientName: string;
  recipientAddressLine1: string | null;
  recipientAddressLine2: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  recipientCountry: string;
  recipientContactName: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  recipientPrivatePerson: boolean;
}

// Numeric columns arrive as strings from Postgres and as numbers from zod.
export interface NumericLikeParcel {
  parcelKind: ParcelKind;
  lengthCm: string | number;
  widthCm: string | number;
  heightCm: string | number;
  weightKg: string | number;
  quantity: number;
  stackable: boolean;
  loadingMeters: string | number | null;
  description: string | null;
}

export function buildProviderShipment(
  recipient: RecipientPartyFields,
  sender: SenderParty,
  parcels: NumericLikeParcel[],
  refs: { referenceId: string; senderReference: string | null; receiverReference: string | null }
): ProviderShipment {
  return {
    sender: {
      name: sender.senderName ?? "",
      addressLine1: sender.senderAddressLine1 ?? "",
      addressLine2: sender.senderAddressLine2,
      postalCode: sender.senderPostalCode ?? "",
      city: sender.senderCity ?? "",
      countryCode: sender.senderCountry,
      contactName: sender.senderContactName,
      phone: sender.senderPhone,
      email: sender.senderEmail,
    },
    recipient: {
      name: recipient.recipientName,
      addressLine1: recipient.recipientAddressLine1 ?? "",
      addressLine2: recipient.recipientAddressLine2,
      postalCode: recipient.recipientPostalCode ?? "",
      city: recipient.recipientCity ?? "",
      countryCode: recipient.recipientCountry,
      contactName: recipient.recipientContactName,
      phone: recipient.recipientPhone,
      email: recipient.recipientEmail,
      privatePerson: recipient.recipientPrivatePerson,
    },
    parcels: parcels.map((p) => ({
      kind: p.parcelKind,
      lengthCm: Number(p.lengthCm),
      widthCm: Number(p.widthCm),
      heightCm: Number(p.heightCm),
      weightKg: Number(p.weightKg),
      quantity: p.quantity,
      stackable: p.stackable,
      loadingMeters: p.loadingMeters === null ? null : Number(p.loadingMeters),
      description: p.description,
    })),
    referenceId: refs.referenceId,
    senderReference: refs.senderReference,
    receiverReference: refs.receiverReference,
  };
}
