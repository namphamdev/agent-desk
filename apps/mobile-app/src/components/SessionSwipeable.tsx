import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

import { Fonts, Theme } from '../theme/Theme';
import { fs, useThemedStyles } from '../theme/Appearance';

interface Props {
  children: React.ReactNode;
  onDelete: () => void;
}

export function SessionSwipeable({ children, onDelete }: Props) {
  const styles = useThemedStyles(() => makeStyles(), []);
  return (
    <Swipeable
      renderRightActions={() => (
        <View style={styles.actionContainer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete session"
            onPress={onDelete}
            style={({ pressed }) => [
              styles.deleteButton,
              pressed && styles.deleteButtonPressed,
            ]}
          >
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        </View>
      )}
      overshootRight={false}
    >
      {children}
    </Swipeable>
  );
}

function makeStyles() {
  return StyleSheet.create({
  actionContainer: {
    justifyContent: 'center',
    marginVertical: 1,
  },
  deleteButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 84,
    height: '100%',
    backgroundColor: Theme.danger,
  },
  deleteButtonPressed: {
    opacity: 0.75,
  },
  deleteText: {
    color: Theme.bg,
    fontFamily: Fonts.sansMedium,
    fontSize: fs(12),
  },
  });
}
