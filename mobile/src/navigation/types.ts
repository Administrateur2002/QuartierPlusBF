import type { NavigatorScreenParams } from "@react-navigation/native";

export type MainTabParamList = {
  Accueil: undefined;
  CarteSOS: { voiceSosRequestId?: string } | undefined;
  Marche:
    | {
        voiceRequestId?: string;
        voiceSearch?: string;
        voiceCreateListing?: boolean;
        voiceCreateType?: "listing" | "local" | "service";
      }
    | undefined;
  Messages:
    | {
        voiceRequestId?: string;
        voiceContactQuery?: string;
        voiceChannelId?: "emergency" | "announcements";
      }
    | undefined;
  Talkie: undefined;
  Grin: undefined;
  Profil: undefined;
  Grossistes: undefined;
  EspacePro: undefined;
  Événements: undefined;
  Voyage: undefined;
};

export type EventSummary = {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  location_name: string;
  event_date: string;
  ticket_price: number;
  total_capacity: number;
  tickets_sold: number;
  is_published: boolean;
  latitude: number | null;
  longitude: number | null;
};

export type EventsStackParamList = {
  EventsHome: undefined;
  EventDetail: { eventId: string };
  MyTickets: undefined;
  OrganizerScanner: undefined;
};

export type VoyageStackParamList = {
  VoyageHome: undefined;
  VoyageAgentScanner: { tripId: string };
};

export type RootStackParamList = {
  Welcome: undefined;
  PhoneAuth: { mode?: "login" | "register" } | undefined;
  CompleteProfile: undefined;
  Main: NavigatorScreenParams<MainTabParamList>;
  Checkout:
    | {
        offer?:
          | "ALLIANCE_PRO"
          | "SPONSORED_PIN"
          | "SYNDIC"
          | "TOWN_HALL"
          | "SECURITY_AGENT"
          | "WHOLESALER"
          | "TRANSPORT_COMPANY";
      }
    | undefined;
  AlliancePlus: undefined;
  CommerceGrowth: undefined;
  MyActivity: { activity: "listings" | "services" | "alerts" };
};
