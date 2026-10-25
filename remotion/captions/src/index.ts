import {ensureMaxCharactersPerLine} from './ensure-max-characters-per-line';

export type {Caption} from './caption';
export {
	createTikTokStyleCaptions,
	type CreateTikTokStyleCaptionsInput,
	type CreateTikTokStyleCaptionsOutput,
	type TikTokPage,
	type TikTokToken,
} from './create-tiktok-style-captions';
export type {
	EnsureMaxCharactersPerLineInput,
	EnsureMaxCharactersPerLineOutput,
} from './ensure-max-characters-per-line';
export {parseSrt, type ParseSrtInput, type ParseSrtOutput} from './parse-srt';
export {serializeSrt, type SerializeSrtInput} from './serialize-srt';

export const CaptionsInternals = {
	ensureMaxCharactersPerLine,
};
