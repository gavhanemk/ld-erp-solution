import { useRef, useState } from 'react'
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, Text, View,
} from 'react-native'
import { Send, Sparkles, Check, X, ShieldAlert } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'
import { api, ApiError } from '@/lib/api'
import { Stack } from 'expo-router'
import { Screen, PageHeading, Input, ErrorNotice, Card, Button, Badge } from '@/components/ui'

/**
 * Ask the ERP a question in plain words.
 *
 * The assistant can only reach the parts of the ERP the signed-in person could
 * have looked up themselves — the server filters its tools by the permissions
 * in the token. So there is nothing to guard here beyond showing the answer.
 */

/**
 * A change the assistant has described and saved nowhere yet.
 *
 * Held apart from the messages because the messages array is posted back to
 * the server verbatim on every turn, and the server validates its shape — an
 * extra kind of entry in there is a 400, not a feature.
 */
interface PendingChange {
  title: string
  fields: Array<{ label: string; value: string }>
  note?: string | null
}

interface Message {
  role: 'user' | 'model'
  content: string
}

const SUGGESTIONS = [
  'What is waiting for my approval?',
  'How much do customers owe us?',
  'Show me this month’s sales',
]

export default function AskAI() {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [pending, setPending] = useState<PendingChange | null>(null)
  /**
   * A question with a fixed set of answers.
   *
   * On a phone this matters more than anywhere: typing "Packing Material" with
   * a thumb, correctly, while standing in a godown, is the difference between
   * using the assistant and not bothering.
   */
  const [choices, setChoices] = useState<{ question: string; choices: string[] } | null>(null)
  const scroller = useRef<ScrollView>(null)

  async function send(text: string) {
    const question = text.trim()
    if (!question || busy) return

    const next = [...messages, { role: 'user' as const, content: question }]
    setMessages(next)
    setDraft('')
    setBusy(true)
    setError(null)
    // Cleared before the wait, not after — a card still offering to save
    // something while the yes is in flight reads as though it were ignored.
    setPending(null)
    setChoices(null)

    try {
      const res = await api.post<{
        success: boolean
        data: {
          response: string
          conversationId: string
          saved?: boolean
          pendingChange?: PendingChange | null
          choices?: { question: string; choices: string[] } | null
        }
      }>('/ai/chat', { messages: next, conversationId })

      setConversationId(res.data.conversationId)
      setMessages([...next, { role: 'model', content: res.data.response }])
      setPending(res.data.pendingChange ?? null)
      setChoices(res.data.choices ?? null)
      if (res.data.saved) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The assistant could not answer. Try again.',
      )
      // The question stays on screen so it can be retried without retyping.
    } finally {
      setBusy(false)
      setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 100)
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <Stack.Screen options={{ headerShown: true, title: 'Ask AI', headerBackTitle: 'Back' }} />
        <PageHeading title="Ask AI" subtitle="Ask about your orders, stock or money" />

        <ScrollView
          ref={scroller}
          className="flex-1"
          contentContainerClassName="px-4 pb-4 gap-3"
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <View className="items-center gap-4 py-10">
              <Sparkles size={28} color="#f59e0b" />
              <Text className="text-center text-sm text-muted-foreground">
                Ask a question in your own words.
              </Text>
              <View className="mt-2 w-full gap-2">
                {SUGGESTIONS.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => void send(s)}
                    className="rounded-lg border border-border bg-card p-3 active:opacity-70"
                  >
                    <Text className="text-sm text-foreground">{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {messages.map((m, i) => (
            <View
              key={i}
              className={
                m.role === 'user'
                  ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-teal-500/30 bg-teal-500/15 px-4 py-3'
                  : 'mr-auto max-w-[90%] rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-3'
              }
            >
              <Text className="text-sm text-foreground">{m.content}</Text>
            </View>
          ))}

          {choices && !busy ? (
            <View className="flex-row flex-wrap gap-2">
              {choices.choices.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => void send(c)}
                  className="rounded-full border border-teal-500/30 bg-teal-500/10 px-3.5 py-2 active:opacity-70"
                  accessibilityRole="button"
                  accessibilityLabel={c}
                >
                  <Text className="text-xs text-teal-300">{c}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {pending && !busy ? (
            <Card className="border-amber-500/30 bg-amber-500/[0.07]">
              <View className="flex-row items-center justify-between gap-3">
                <View className="flex-row items-center gap-2 flex-1">
                  <ShieldAlert size={16} color="#d97706" />
                  <Text className="flex-1 text-sm font-semibold text-foreground">
                    {pending.title}
                  </Text>
                </View>
                <Badge label="Not saved" kind="warning" />
              </View>

              <View className="mt-3 gap-2 border-t border-border pt-3">
                {pending.fields.map((f) => (
                  <View key={f.label} className="flex-row items-start justify-between gap-4">
                    <Text className="text-xs text-muted-foreground">{f.label}</Text>
                    <Text className="flex-1 text-right text-sm text-foreground">{f.value}</Text>
                  </View>
                ))}
              </View>

              {pending.note ? (
                <Text className="mt-3 text-xs text-muted-foreground">{pending.note}</Text>
              ) : null}

              {/* Both send an ordinary message. The yes has to arrive as
                  something the person said, on a later turn than the proposal,
                  or the server refuses it — so pressing the button and typing
                  it are the same act. */}
              <View className="mt-4 flex-row gap-3">
                <Button
                  label="Confirm"
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
                    void send('Yes, save it.')
                  }}
                  icon={<Check size={16} color="#fff" />}
                  className="flex-1"
                />
                <Button
                  label="Cancel"
                  kind="secondary"
                  onPress={() => void send('No, cancel that.')}
                  icon={<X size={16} color="#94a3b8" />}
                  className="flex-1"
                />
              </View>
            </Card>
          ) : null}

          {busy ? (
            <View className="mr-auto flex-row items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3">
              <ActivityIndicator size="small" />
              <Text className="text-sm text-muted-foreground">Thinking...</Text>
            </View>
          ) : null}
        </ScrollView>

        {error ? <ErrorNotice message={error} /> : null}

        <View className="flex-row items-end gap-2 border-t border-border px-4 py-3">
          <Input
            value={draft}
            onChangeText={setDraft}
            placeholder="Type your question"
            className="flex-1"
            multiline
            editable={!busy}
            onSubmitEditing={() => void send(draft)}
          />
          <Pressable
            onPress={() => void send(draft)}
            disabled={busy || !draft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Send"
            className={`h-12 w-12 items-center justify-center rounded-lg bg-teal-500 ${busy || !draft.trim() ? 'opacity-50' : 'active:bg-teal-600'}`}
          >
            <Send size={18} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}
