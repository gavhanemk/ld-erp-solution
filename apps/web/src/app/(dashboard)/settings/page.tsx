import { redirect } from 'next/navigation'

/** /settings has no content of its own; Company is where setup starts. */
export default function SettingsIndexPage() {
  redirect('/settings/company')
}
