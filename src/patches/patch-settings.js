const fs = require("fs")
const path = require("path")

// Patches the language picker in app/(tabs)/settings.tsx.
//
// Why: React Native's Android Alert.alert silently truncates the button list
// to 3 (see Libraries/Alert/Alert.js: buttons.slice(0, 3)). Adding a fourth
// option ("ru") to that Alert would therefore drop it on Android, so the
// Russian entry could never appear. This patch replaces the Alert with a
// Modal-based picker that lists all four locales (system, ru, en, zh-Hans)
// as pressable rows.

const TARGET = process.argv[2]
if (!TARGET) {
  console.error("usage: node patch-settings.js <repo-root>")
  process.exit(1)
}

const file = path.join(TARGET, "app", "(tabs)", "settings.tsx")
if (!fs.existsSync(file)) {
  console.error("settings.tsx not found: " + file)
  process.exit(1)
}

let src = fs.readFileSync(file, "utf8")

function replaceOnce(haystack, needle, replacement, label) {
  const idx = haystack.indexOf(needle)
  if (idx === -1) {
    console.error("settings.tsx patch FAILED: marker not found: " + label)
    process.exit(1)
  }
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
}

// 1) Pull in Modal from react-native.
src = replaceOnce(
  src,
  '  Alert,\n} from "react-native"',
  '  Alert,\n  Modal,\n} from "react-native"',
  "react-native import",
)

// 2) Replace the locale map + Alert-based handler with a Modal-driven one.
const oldBlock = `  const localeLabels: Record<LocalePreference, string> = {
    system: t("settings.language.system"),
    en: t("settings.language.en"),
    "zh-Hans": t("settings.language.zhHans"),
  }

  const handleLanguagePress = useCallback(() => {
    Alert.alert(t("settings.language.title"), undefined, [
      { text: localeLabels.system, onPress: () => setLocale("system") },
      { text: localeLabels.en, onPress: () => setLocale("en") },
      { text: localeLabels["zh-Hans"], onPress: () => setLocale("zh-Hans") },
      { text: t("common.cancel"), style: "cancel" },
    ])
  }, [t, setLocale, localeLabels])`

const newBlock = `  const localeLabels: Record<LocalePreference, string> = {
    system: t("settings.language.system"),
    ru: t("settings.language.ru"),
    en: t("settings.language.en"),
    "zh-Hans": t("settings.language.zhHans"),
  }

  const [languagePickerVisible, setLanguagePickerVisible] = useState(false)

  const handleLanguagePress = useCallback(() => {
    setLanguagePickerVisible(true)
  }, [])

  const chooseLocale = useCallback(
    (next: LocalePreference) => {
      setLocale(next)
      setLanguagePickerVisible(false)
    },
    [setLocale],
  )`

src = replaceOnce(src, oldBlock, newBlock, "language handler")

// 3) Insert the Modal picker just before the closing </ScrollView>.
const modalJSX = `      <Modal
        visible={languagePickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLanguagePickerVisible(false)}
      >
        <View style={[styles.modalOverlay, isDark && styles.modalOverlayDark]}>
          <View style={[styles.modalCard, isDark && styles.modalCardDark]}>
            <Text style={[styles.modalTitle, isDark && styles.textDark]}>
              {t("settings.language.title")}
            </Text>
            <TouchableOpacity
              style={[styles.modalOption, locale === "system" && styles.modalOptionActive]}
              onPress={() => chooseLocale("system")}
            >
              <Text style={[styles.modalOptionText, isDark && styles.textDark]}>{localeLabels.system}</Text>
              {locale === "system" ? <Ionicons name="checkmark" size={20} color="#22c55e" /> : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalOption, locale === "ru" && styles.modalOptionActive]}
              onPress={() => chooseLocale("ru")}
            >
              <Text style={[styles.modalOptionText, isDark && styles.textDark]}>{localeLabels.ru}</Text>
              {locale === "ru" ? <Ionicons name="checkmark" size={20} color="#22c55e" /> : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalOption, locale === "en" && styles.modalOptionActive]}
              onPress={() => chooseLocale("en")}
            >
              <Text style={[styles.modalOptionText, isDark && styles.textDark]}>{localeLabels.en}</Text>
              {locale === "en" ? <Ionicons name="checkmark" size={20} color="#22c55e" /> : null}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalOption, locale === "zh-Hans" && styles.modalOptionActive]}
              onPress={() => chooseLocale("zh-Hans")}
            >
              <Text style={[styles.modalOptionText, isDark && styles.textDark]}>{localeLabels["zh-Hans"]}</Text>
              {locale === "zh-Hans" ? <Ionicons name="checkmark" size={20} color="#22c55e" /> : null}
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalCancel} onPress={() => setLanguagePickerVisible(false)}>
              <Text style={[styles.modalCancelText, isDark && styles.metaDark]}>{t("common.cancel")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </ScrollView>`

src = replaceOnce(src, "    </ScrollView>", modalJSX, "scrollview close")

// 4) Add the modal styles at the end of the StyleSheet.create({...}).
const styleAnchor = "  footerText: {\n    fontSize: 13,\n    color: \"#999999\",\n    textAlign: \"center\",\n  },\n})"
const styleBlock = `  footerText: {
    fontSize: 13,
    color: "#999999",
    textAlign: "center",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalOverlayDark: {
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  modalCard: {
    width: "80%",
    maxWidth: 360,
    borderRadius: 12,
    backgroundColor: "#ffffff",
    paddingTop: 8,
  },
  modalCardDark: {
    backgroundColor: "#1a1a1a",
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0a0a0a",
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
  },
  modalOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  modalOptionActive: {
    backgroundColor: "rgba(34,197,94,0.1)",
  },
  modalOptionText: {
    fontSize: 15,
    color: "#0a0a0a",
  },
  modalCancel: {
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    marginTop: 4,
  },
  modalCancelText: {
    fontSize: 15,
    color: "#666666",
    textAlign: "center",
    paddingVertical: 12,
  },
})`

src = replaceOnce(src, styleAnchor, styleBlock, "style sheet")

fs.writeFileSync(file, src)
console.log("settings.tsx: language picker replaced with Modal")