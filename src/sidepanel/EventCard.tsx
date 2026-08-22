// The history card remains shared with the legacy popup test harness while the
// side panel is the product surface. This boundary gives side-panel code a
// stable import without duplicating the card implementation.
export { EventCard, type EventCardProps } from '../popup/EventCard';
