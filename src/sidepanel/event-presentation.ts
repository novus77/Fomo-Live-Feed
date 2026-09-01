import type { ActivityAction } from '../domain/activity';

const EVENT_PRESENTATION_CLASS: Record<ActivityAction, string> = {
  buy: 'event-card-buy',
  sell: 'event-card-sell',
  thesis: 'event-card-thesis',
  transfer: 'event-card-transfer',
  withdraw: 'event-card-withdraw',
};

export const eventPresentationClass = (action: ActivityAction): string =>
  EVENT_PRESENTATION_CLASS[action];
