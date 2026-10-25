import {createContext, useContext} from 'react';
import type {LogLevel} from './log';

export type LoggingContextValue = {
	logLevel: LogLevel | null;
	mountTime: number;
};

export const LogLevelContext = createContext<LoggingContextValue>({
	logLevel: 'info',
	mountTime: 0,
});

export const useLogLevel = (): LogLevel => {
	const {logLevel} = useContext(LogLevelContext);
	if (logLevel === null) {
		throw new Error('useLogLevel must be used within a LogLevelProvider');
	}

	return logLevel;
};

export const useMountTime = (): number => {
	const {mountTime} = useContext(LogLevelContext);
	if (mountTime === null) {
		throw new Error('useMountTime must be used within a LogLevelProvider');
	}

	return mountTime;
};
