// QuestionPanel — RN port of ComposerView.swift's QuestionPanel.
// Paged, numbered options with auto-advance for single-select after 220ms.

import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { Fonts, overlay, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';
import { withAlpha } from '../theme/color';
import type { UserInputAnswer, UserInputQuestion } from '../models/Entities';

interface Props {
  requestId: string;
  questions: UserInputQuestion[];
  onRespond: (requestId: string, answers: UserInputAnswer[]) => void;
}

export function QuestionPanel({ requestId, questions, onRespond }: Props) {
  const styles = useThemedStyles(() => makeStyles(), []);
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Record<string, Set<string>>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const autoAdvance = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (questions.length === 0) return null;
  const safePage = Math.min(Math.max(page, 0), questions.length - 1);
  const question = questions[safePage];

  const canAdvance = (() => {
    const t = typed[question.id] ?? '';
    if (t.length > 0) return true;
    return (picked[question.id]?.size ?? 0) > 0;
  })();

  const pick = (option: string) => {
    void Haptics.selectionAsync();
    setTyped((prev) => ({ ...prev, [question.id]: '' }));
    if (question.multiSelect === true) {
      setPicked((prev) => {
        const set = new Set(prev[question.id] ?? []);
        if (set.has(option)) set.delete(option);
        else set.add(option);
        return { ...prev, [question.id]: set };
      });
    } else {
      setPicked((prev) => ({ ...prev, [question.id]: new Set([option]) }));
      if (autoAdvance.current) clearTimeout(autoAdvance.current);
      autoAdvance.current = setTimeout(() => advance(), 220);
    }
  };

  const advance = () => {
    if (!canAdvance) return;
    if (safePage < questions.length - 1) {
      setPage(safePage + 1);
      return;
    }
    const answers = questions.map((q) => {
      const t = (typed[q.id] ?? '').trim();
      if (t.length > 0) return { questionId: q.id, labels: [t] };
      return { questionId: q.id, labels: Array.from(picked[q.id] ?? []) };
    });
    onRespond(requestId, answers);
  };

  useEffect(() => {
    return () => {
      if (autoAdvance.current) clearTimeout(autoAdvance.current);
    };
  }, []);

  return (
    <View style={styles.shell}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={styles.header}>{question.header.toUpperCase()}</Text>
        {questions.length > 1 ? (
          <View style={styles.pageBadge}>
            <Text style={styles.pageBadgeText}>{safePage + 1}/{questions.length}</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.question}>{question.question}</Text>

      {question.multiSelect === true ? (
        <Text style={styles.hint}>Select one or more options.</Text>
      ) : null}

      <View style={{ gap: 4 }}>
        {question.options.map((option, ix) => {
          const isPicked = (typed[question.id] ?? '').length === 0
            && (picked[question.id]?.has(option) ?? false);
          return (
            <Pressable
              key={option}
              onPress={() => pick(option)}
              style={({ pressed }) => [
                styles.optionRow,
                {
                  backgroundColor: isPicked ? overlay(0.09) : pressed ? overlay(0.05) : overlay(0.025),
                  borderColor: isPicked ? overlay(0.16) : 'transparent',
                },
              ]}
            >
              <Text style={styles.optionText}>{option}</Text>
              {ix < 9 ? (
                <View style={styles.optionNumBadge}>
                  <Text style={styles.optionNum}>{ix + 1}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.divider} />
      <TextInput
        value={typed[question.id] ?? ''}
        onChangeText={(v) => setTyped((prev) => ({ ...prev, [question.id]: v }))}
        placeholder="Or type your own answer"
        placeholderTextColor={Theme.textFaint}
        style={styles.ownAnswerInput}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
        {safePage > 0 ? (
          <Pressable onPress={() => setPage(safePage - 1)}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={advance}
          disabled={!canAdvance}
          style={({ pressed }) => ({
            opacity: canAdvance ? (pressed ? 0.85 : 1) : 0.4,
            backgroundColor: Theme.text,
            paddingHorizontal: 16,
            height: 34,
            borderRadius: 17,
            justifyContent: 'center',
          })}
        >
          <Text style={{ color: Theme.bg, fontFamily: Fonts.sansSemiBold, fontSize: fs(13) }}>
            {safePage < questions.length - 1 ? 'Next' : 'Submit'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
  shell: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginHorizontal: 12,
    backgroundColor: overlay(0.04),
    borderColor: overlay(0.05),
    borderWidth: 1,
    borderRadius: 26,
    gap: 12,
  },
  header: {
    fontFamily: Fonts.sansMedium,
    fontSize: fs(10.5),
    letterSpacing: 1,
    color: withAlpha(Theme.textMuted, 0.6),
  },
  question: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: fs(15),
    color: Theme.text,
  },
  hint: {
    fontFamily: Fonts.sans,
    fontSize: fs(12),
    color: Theme.textMuted,
  },
  pageBadge: {
    backgroundColor: overlay(0.06),
    borderRadius: 6,
    paddingHorizontal: 6,
    height: 20,
    justifyContent: 'center',
  },
  pageBadgeText: {
    fontFamily: Fonts.sans,
    fontSize: fs(10),
    color: Theme.textMuted,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  optionText: {
    flex: 1,
    fontFamily: Fonts.sansSemiBold,
    fontSize: fs(13.5),
    color: Theme.text,
  },
  optionNumBadge: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: overlay(0.06),
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionNum: {
    fontFamily: Fonts.sans,
    fontSize: fs(11),
    color: Theme.textMuted,
  },
  divider: {
    height: 1,
    backgroundColor: overlay(0.06),
    marginTop: 6,
  },
  ownAnswerInput: {
    fontFamily: Fonts.sans,
    fontSize: fs(13),
    color: Theme.text,
    paddingVertical: 6,
    paddingHorizontal: 0,
  },
  backText: {
    fontFamily: Fonts.sansMedium,
    fontSize: fs(13),
    color: Theme.textMuted,
  },
  });
}

