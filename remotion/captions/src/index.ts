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
export {parseSrt, ParseSrtInput, ParseSrtOutput} from './parse-srt';
export {parseVtt, ParseVttInput, ParseVttOutput} from './parse-vtt';
export {serializeSrt, SerializeSrtInput} from './serialize-srt';

export const CaptionsInternals = {
	ensureMaxCharactersPerLine,
};
