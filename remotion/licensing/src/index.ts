import {internalRegisterUsageEvent} from './register-usage-event';

export {
	type UsageEventClassification as Classification,
	registerUsageEvent,
	type RegisterUsageEventResponse,
} from './register-usage-event';

export {type EventCount, getUsage, type GetUsageResponse} from './get-usage';

export const LicensingInternals = {
	internalRegisterUsageEvent,
};
