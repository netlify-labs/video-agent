// The run prompt's engine-specific lines (render-engines plan §5.3) for engines other than HyperFrames. HyperFrames'
// lines stay where they are in prompt.ts, so its prompt is byte-identical to before engines existed; buildPrompt asks
// this module only when the version's engine isn't HyperFrames. Phase 2: Remotion authoring, silent or a music bed.
import type { EngineId } from './engines.js'

/** What the media library line says about using images, clips and fonts. */
export const REMOTION_MEDIA_LINE =
  "Media from the team library, already in video/ at these paths (prepare-run puts them there). Use them where they fit the request; a caption says what an item is. Put images and clips in a beat's media slots (props.json beats[].media, shown with <VaImage slot> or <VaClip slot>, see video/AGENTS.md); load fonts with loadFont from @remotion/fonts and staticFile. Never download other media."

/** Steps 1-3 of an authoring or revision run on Remotion; steps 4-6 (summary.json, render-job) are the same. */
export function remotionAuthorSteps(p: { width: number; height: number }): string[] {
  return [
    "1. Read the remotion-best-practices skill and the markup and render rules it routes to. Don't start Remotion Studio or open a browser, and ignore the skill's advice not to render: this machine has no screen and a deadline, and render-job renders the video. To see your work, run `npx tsx scripts/engine.ts snapshot --at <seconds,…>` with every moment you want in one call (each call costs time and counts as a render) and look at the PNGs in video/.render/snapshots/. The project is video/, set up with its dependencies installed.",
    `2. Follow the editing contract in video/AGENTS.md ("Editing contract v1 (Remotion)"). Write video/props.json first (${p.width}x${p.height}, fps 30), then one component per beat in video/src/beats/<id>.tsx, reading every text, colour and media item through the va/ components. Write only props.json, summary.json, src/beats/, src/layers/ and assets/. Don't change video/src/va/, src/Root.tsx, src/index.ts, src/registry.ts, package.json, the lockfile, remotion.config.ts or tsconfig.json, don't add other config files, don't install packages and don't read process.env: \`engine.ts check\` regenerates the registry for you.`,
    '   Use only files in video/: fonts from video/assets/fonts with loadFont from @remotion/fonts and staticFile, never Google Fonts or any URL. No fetch, no random numbers, no clock (Math.random, Date.now).',
    '3. Run `npx tsx scripts/engine.ts check` until it reports 0 errors. Say in your summary that contrast was reviewed by eye, not measured.',
  ]
}

/** The sound rules on Remotion: a music bed or nothing (effects and voice-over arrive in Phase 4). */
export function remotionSoundLines(
  sound: 'silent' | 'music' | 'music_sfx',
  tracks: { file: string; caption: string | null; seconds: number | null; credit?: string }[],
  brandMusic: { file: string; genre: string | null; tempo: string | null } | null,
  fence: (json: unknown) => string[],
): string[] {
  if (sound === 'silent') return []
  const out = [
    '',
    'Sound: a music bed only (Remotion videos have no sound effects or voice-over yet).',
    '- Music: set props.json audio.music to { "id": "music", "label": "Music", "src": "<the track, under assets/>", "volume": 1, "muted": false, "fadeIn": about 1, "fadeOut": about 1.5 }. The va/ runtime plays it under the whole video and fades it in and out, also after edits.',
  ]
  if (tracks.length) {
    out.push(
      `- Use ${tracks.length === 1 ? 'this track' : 'the first track (the others only if the request asks)'} from the team library, already in video/ at this path (prepare-run puts it there): set audio.music.src to its path. seconds is its length; a caption is the uploader's note about the track:`,
      ...fence(tracks),
    )
    if (tracks.some((t) => t.credit))
      out.push(
        '- A track with a credit is CC BY: the app credits it under the video and on its share page, so leave it off the picture unless the request asks for on-screen credits.',
      )
  } else if (brandMusic) {
    out.push(
      `- No track was picked: use the brand's music, ${brandMusic.file} (copy it into video/assets/music/ and set audio.music.src to its path there). Its feel, as JSON:`,
      ...fence({ genre: brandMusic.genre, tempo: brandMusic.tempo }),
    )
  } else {
    out.push(
      '- No track was picked and the brand has none: find one on Openverse (CC0 and CC BY only) with the helper, run from the repo root:',
      '  npx tsx scripts/openverse.ts search "<the mood, genre and tempo the video needs>" --min-seconds <the video\'s length>, then npx tsx scripts/openverse.ts fetch <id> --name <short-slug>. It saves the file to video/assets/music/ and records its credit; set audio.music.src to "assets/music/<file>" and name the track in your summary.',
      '- If openverse.ts fails twice, make the video without music and say why in your summary. Get music only through openverse.ts.',
    )
  }
  out.push(
    "- Then run npx tsx scripts/engine.ts mix: it sets audio.music.volume from the track's measured loudness (about -14 LUFS, true peak at or below -1 dBTP). Say in your summary that the mix was measured, not heard.",
  )
  return out
}

/** Whether the prompt's engine-specific lines come from this module. */
export const usesEnginePrompt = (engine: EngineId | undefined) =>
  engine !== undefined && engine !== 'hyperframes'
