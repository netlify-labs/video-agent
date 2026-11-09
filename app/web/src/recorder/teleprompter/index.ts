// The recorder's teleprompter (docs/plans/2026-11-02-record-your-own-voiceover.md §2.1 step 3, §5.3): what the record
// flow (va-2qq.4.11) puts beside the picture while a take records.
export * from './lines'
export {
  FONT_SIZES,
  NARROW_MAX_PX,
  PrompterLayout,
  Teleprompter,
  isPrompterToggle,
  isTextField,
  prompterLayout,
  usePrompterLayout,
  type PrompterLayoutKind,
  type TeleprompterProps,
} from './Teleprompter'
