// Other places to find music and sounds for videos, shown under Find music. Licences differ by site and sometimes by
// track, so each note says what to check; downloaded files go into the library with Upload on the Media page.
export interface MusicSource {
  name: string
  url: string
  /** What the licence allows, in a few words. */
  licence: string
  /** What the site is good for. */
  note: string
}

export const MUSIC_SOURCES: MusicSource[] = [
  {
    name: 'YouTube Audio Library',
    url: 'https://studio.youtube.com/channel/UC/music',
    licence: 'Free; some tracks need a credit',
    note: 'Large, well-tagged catalog from YouTube. Needs a YouTube account; check each track’s terms.',
  },
  {
    name: 'Pixabay Music',
    url: 'https://pixabay.com/music/',
    licence: 'Free, commercial use, no credit',
    note: 'Modern background music in every mood, plus sound effects.',
  },
  {
    name: 'Mixkit',
    url: 'https://mixkit.co/free-stock-music/',
    licence: 'Free, commercial use, no credit',
    note: 'Short, polished tracks that suit product and launch videos.',
  },
  {
    name: 'Incompetech (Kevin MacLeod)',
    url: 'https://incompetech.com/music/royalty-free/music.html',
    licence: 'CC BY 4.0: credit required',
    note: 'Thousands of tracks searchable by mood, genre and tempo.',
  },
  {
    name: 'Free Music Archive',
    url: 'https://freemusicarchive.org/',
    licence: 'Varies by track: filter for CC0 or CC BY',
    note: 'Independent artists; skip NC (non-commercial) and ND (no-derivatives) tracks.',
  },
  {
    name: 'ccMixter',
    url: 'https://dig.ccmixter.org/',
    licence: 'Creative Commons: often CC BY, some NC',
    note: 'Remixes and instrumentals; the "instrumental" filter finds background tracks.',
  },
  {
    name: 'Uppbeat',
    url: 'https://uppbeat.io/',
    licence: 'Free tier with a credit; paid plan without',
    note: 'Curated tracks for creators; free accounts have a monthly download limit.',
  },
  {
    name: 'Musopen',
    url: 'https://musopen.org/music/',
    licence: 'Public domain recordings',
    note: 'Classical music, free of copyright.',
  },
  {
    name: 'Freesound',
    url: 'https://freesound.org/',
    licence: 'Varies by sound: CC0, CC BY or CC BY-NC',
    note: 'Sound effects and ambiences; filter by licence before downloading.',
  },
  {
    name: 'Openverse',
    url: 'https://openverse.org/search/audio',
    licence: 'Creative Commons and public domain',
    note: 'The same catalog Find music searches, on Openverse’s own site.',
  },
]
