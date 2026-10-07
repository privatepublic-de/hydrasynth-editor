package edisyn.synth.asmhydrasynth;

import edisyn.*;
import edisyn.gui.*;
import java.awt.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import javax.sound.midi.*;
import javax.swing.*;

/**
 * Runs Edisyn's Hydrasynth driver headless and dumps what it knows as JSON lines:
 *   meta    one line per key: range, widget, labels, display strings
 *   layout  every (key, pos, width, bit) parseReal reads, over the given patches
 *   values  per patch: every key's value after parseReal
 *   nrpn    per key and value: the CC stream emitAll(key) produces
 * Usage: java -Djava.awt.headless=true -cp build:harness edisyn.synth.asmhydrasynth.Extract <out dir> <patch .bin files...>
 */
public class Extract extends ASMHydrasynth {
    static final int PATCH = 2790;
    final Set<String> layout = new TreeSet<>();

    @Override void set1(String key, byte[] data, int pos, int bit) { layout.add(key + "\t" + pos + "\t1\t" + bit); super.set1(key, data, pos, bit); }
    @Override void set1(String key, byte[] data, int pos) { layout.add(key + "\t" + pos + "\t1\t-1"); super.set1(key, data, pos); }
    @Override void set2(String key, byte[] data, int pos) { layout.add(key + "\t" + pos + "\t2\t-1"); super.set2(key, data, pos); }

    static String q(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 32 || c > 126) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }

    static void labels(Component c, java.util.List<String> out) {
        String t = c instanceof JLabel ? ((JLabel) c).getText() : c instanceof AbstractButton ? ((AbstractButton) c).getText() : null;
        if (t != null && !t.trim().isEmpty() && !t.trim().equals("88888")) out.add(t.trim());
        if (c instanceof Container) for (Component k : ((Container) c).getComponents()) labels(k, out);
    }

    static Object field(Object o, String name) throws Exception {
        for (Class<?> k = o.getClass(); k != null; k = k.getSuperclass()) {
            try { Field f = k.getDeclaredField(name); f.setAccessible(true); return f.get(o); } catch (NoSuchFieldException e) { }
        }
        return null;
    }

    /** The mode a key's NRPN depends on (Edisyn's emitAll bails out of the wrong variant). */
    static Map<String,Integer> context(String key) {
        Map<String,Integer> c = new LinkedHashMap<>();
        java.util.regex.Matcher x;
        if ((x = java.util.regex.Pattern.compile("^(pre|post)fx(\\d)param\\d$").matcher(key)).find()) c.put(x.group(1) + "fxtype", Integer.parseInt(x.group(2)));
        else if ((x = java.util.regex.Pattern.compile("^((?:env|lfo)\\d)\\w+sync(on|off)$").matcher(key)).find()) c.put(x.group(1) + "bpmsync", x.group(2).equals("on") ? 1 : 0);
        else if ((x = java.util.regex.Pattern.compile("^delaytimesync(on|off)$").matcher(key)).find()) c.put("delaybpmsync", x.group(1).equals("on") ? 1 : 0);
        else if ((x = java.util.regex.Pattern.compile("^voicevibratoratesync(on|off)$").matcher(key)).find()) c.put("voicevibratobpmsync", x.group(1).equals("on") ? 1 : 0);
        else if ((x = java.util.regex.Pattern.compile("^(mutant\\d)source(oscsync|fmlin)$").matcher(key)).find()) c.put(x.group(1) + "mode", x.group(2).equals("oscsync") ? 2 : 0);
        return c;
    }

    public static void main(String[] args) throws Exception {
        Path out = Paths.get(args[0]);
        Files.createDirectories(out);
        Extract s = new Extract();
        Model m = s.getModel();
        String[] keys = m.getKeys();
        Arrays.sort(keys);

        // ---- meta
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out.resolve("meta.jsonl")))) {
            for (String key : keys) {
                StringBuilder b = new StringBuilder("{\"key\":" + q(key));
                if (m.isString(key)) { w.println(b.append(",\"string\":true}")); continue; }
                int min = m.getMin(key), max = m.getMax(key);
                b.append(",\"min\":").append(min).append(",\"max\":").append(max).append(",\"default\":").append(m.get(key));
                ArrayList listeners = m.getListeners(key);
                if (listeners != null) for (Object l : listeners) {
                    if (!(l instanceof NumericalComponent)) continue;
                    NumericalComponent nc = (NumericalComponent) l;
                    java.util.List<String> ls = new ArrayList<>();
                    labels(nc, ls);
                    String kind = nc instanceof Chooser ? "choice" : nc instanceof CheckBox ? "check" : nc instanceof LabelledDial ? "dial" : nc.getClass().getName();
                    b.append(",\"kind\":").append(q(kind))
                     .append(",\"widgetClass\":").append(q(nc.getClass().getName()));
                    b.append(",\"labels\":[");
                    for (int i = 0; i < ls.size(); i++) b.append(i > 0 ? "," : "").append(q(ls.get(i)));
                    b.append("]");
                    if (nc instanceof Chooser) {
                        int[] vals = (int[]) field(nc, "vals");
                        String[] lab = (String[]) field(nc, "labels");
                        b.append(",\"choices\":[");
                        for (int i = 0; lab != null && i < lab.length; i++)
                            b.append(i > 0 ? "," : "").append("[").append(vals == null ? i : vals[i]).append(",").append(q(lab[i])).append("]");
                        b.append("]");
                    } else if (nc instanceof LabelledDial && max - min <= 20000) {
                        b.append(",\"display\":[");
                        for (int v = min; v <= max; v++) b.append(v > min ? "," : "").append(q(((LabelledDial) nc).map(v)));
                        b.append("]");
                    }
                    break;
                }
                w.println(b.append("}"));
            }
        }

        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out.resolve("tables.json")))) {
            w.print("{\"MOD_DESTINATION_CATEGORIES\":" + Arrays.toString(MOD_DESTINATION_CATEGORIES) + "}");
        }

        // ---- layout + values over real patches
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out.resolve("values.jsonl")))) {
            for (int a = 1; a < args.length; a++) {
                byte[] all = Files.readAllBytes(Paths.get(args[a]));
                for (int n = 0; n * PATCH < all.length; n++) {
                    byte[] p = Arrays.copyOfRange(all, n * PATCH, (n + 1) * PATCH);
                    s.parseReal(p, true);
                    StringBuilder b = new StringBuilder("{\"file\":" + q(Paths.get(args[a]).getFileName().toString()) + ",\"index\":" + n + ",\"values\":{");
                    boolean first = true;
                    for (String key : keys) {
                        b.append(first ? "" : ",").append(q(key)).append(":");
                        b.append(m.isString(key) ? q(m.get(key, "")) : String.valueOf(m.get(key)));
                        first = false;
                    }
                    w.println(b.append("}}"));
                }
            }
        }
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out.resolve("layout.tsv")))) {
            for (String l : s.layout) w.println(l);
        }

        // ---- NRPN: every value of every key, from a fresh model each key
        try (PrintWriter w = new PrintWriter(Files.newBufferedWriter(out.resolve("nrpn.jsonl")))) {
            for (String key : keys) {
                if (m.isString(key)) continue;
                int min = m.getMin(key), max = m.getMax(key);
                Map<String,Integer> ctx = context(key);
                Map<String,Integer> saved = new HashMap<>();
                for (Map.Entry<String,Integer> e : ctx.entrySet()) { saved.put(e.getKey(), m.get(e.getKey())); m.set(e.getKey(), e.getValue()); }
                int savedVal = m.get(key);
                StringBuilder b = new StringBuilder("{\"key\":" + q(key) + ",\"context\":{");
                boolean fc = true;
                for (Map.Entry<String,Integer> e : ctx.entrySet()) { b.append(fc ? "" : ",").append(q(e.getKey())).append(":").append(e.getValue()); fc = false; }
                b.append("},\"emits\":[");
                for (int v = min; v <= max; v++) {
                    m.set(key, v);
                    Object[] msgs = s.emitAll(key);
                    b.append(v > min ? "," : "").append("[").append(v);
                    if (msgs == null) b.append(",null");
                    else for (Object o : msgs) {
                        if (o instanceof ShortMessage) {
                            ShortMessage sm = (ShortMessage) o;
                            b.append(",[").append(sm.getData1()).append(",").append(sm.getData2()).append("]");
                        } else if (o instanceof Integer) b.append(",{\"pause\":").append(o).append("}");
                        else if (o != null) b.append(",").append(q(o.getClass().getSimpleName()));
                    }
                    b.append("]");
                }
                w.println(b.append("]}"));
                m.set(key, savedVal);
                for (Map.Entry<String,Integer> e : saved.entrySet()) m.set(e.getKey(), e.getValue());
            }
        }
        System.exit(0);
    }
}
