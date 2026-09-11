package dev.tpquestvr.launcher;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final int PICK_GAME = 1001;
    private static final String PREFS = "tpquestvr";
    private static final String KEY_URI = "game_uri";
    private static final String KEY_NAME = "game_name";

    private SharedPreferences prefs;
    private TextView selected;
    private Button play;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildUi();

        if (prefs.getString(KEY_URI, null) == null) {
            findViewById(android.R.id.content).post(this::chooseGame);
        }
    }

    private void buildUi() {
        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (28 * d);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.rgb(12, 14, 18));

        TextView title = new TextView(this);
        title.setText("TWILIGHT PRINCESS VR");
        title.setTextColor(Color.WHITE);
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        TextView info = new TextView(this);
        info.setText("\nSelect your legally dumped Twilight Princess game file.\nThis launcher passes it directly to Dusklight VR.");
        info.setTextColor(Color.LTGRAY);
        info.setTextSize(16);
        info.setGravity(Gravity.CENTER);
        root.addView(info);

        selected = new TextView(this);
        selected.setTextColor(Color.WHITE);
        selected.setTextSize(16);
        selected.setGravity(Gravity.CENTER);
        selected.setPadding(0, pad, 0, pad);
        root.addView(selected);

        play = new Button(this);
        play.setText("PLAY IN VR");
        play.setOnClickListener(v -> launchDusklight());
        root.addView(play, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        Button choose = new Button(this);
        choose.setText("CHOOSE / CHANGE GAME FILE");
        choose.setOnClickListener(v -> chooseGame());
        LinearLayout.LayoutParams chooseParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        chooseParams.topMargin = (int) (12 * d);
        root.addView(choose, chooseParams);

        setContentView(root);
        refresh();
    }

    private void chooseGame() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(i, PICK_GAME);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_GAME || resultCode != RESULT_OK || data == null) {
            return;
        }

        Uri uri = data.getData();
        if (uri == null) {
            return;
        }

        int takeFlags = data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
        try {
            getContentResolver().takePersistableUriPermission(uri, takeFlags);
        } catch (SecurityException ignored) {
        }

        prefs.edit()
                .putString(KEY_URI, uri.toString())
                .putString(KEY_NAME, displayName(uri))
                .apply();
        refresh();
    }

    private void refresh() {
        String uri = prefs.getString(KEY_URI, null);
        String name = prefs.getString(KEY_NAME, null);
        play.setEnabled(uri != null);
        selected.setText(uri == null
                ? "No game file selected."
                : "Selected: " + (name == null ? "Twilight Princess game file" : name));
    }

    private String displayName(Uri uri) {
        ContentResolver resolver = getContentResolver();
        try (Cursor c = resolver.query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME},
                null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int col = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (col >= 0) {
                    return c.getString(col);
                }
            }
        } catch (Exception ignored) {
        }
        return uri.getLastPathSegment();
    }

    private void launchDusklight() {
        String raw = prefs.getString(KEY_URI, null);
        if (raw == null) {
            chooseGame();
            return;
        }

        Uri uri = Uri.parse(raw);
        Intent i = new Intent();
        i.setClassName("dev.twilitrealm.dusk", "dev.twilitrealm.dusk.DuskActivity");
        i.setData(uri);
        i.setClipData(ClipData.newRawUri("Twilight Princess", uri));
        i.putExtra("dusk_argv", new String[]{"--dvd", raw});
        i.putExtra("dusk_args", "--dvd \"" + raw + "\"");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TASK);

        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this,
                    "Dusklight VR is not installed, or its activity could not be started.",
                    Toast.LENGTH_LONG).show();
        } catch (SecurityException e) {
            Toast.makeText(this,
                    "Quest blocked the handoff to Dusklight VR.",
                    Toast.LENGTH_LONG).show();
        }
    }
}
