# Releasing

The plugin market index is a separate repository:
[douglarek/dsh-plugin-index](https://github.com/douglarek/dsh-plugin-index).
It is **not** updated automatically.

Every version bump must update the index.

## Checklist

1. Bump `package.json` to the new exact SemVer version.
2. Add the README/behavior changes and commit.
3. Capture the release commit and time:

   ```bash
   git rev-parse HEAD
   git show -s --format=%ct HEAD
   ```

4. In `dsh-plugin-index/index.json`, add a version entry under
   `plugins[name="@douglarek/dsh-cpa-search-provider"].versions`:

   ```json
   {
     "version": "0.2.0",
     "publishTimestamp": 1794491479,
     "source": {
       "type": "git",
       "url": "https://github.com/douglarek/dsh-cpa-search-provider",
       "commit": "<full 40-hex release commit>"
     },
     "engines": {}
   }
   ```

5. Commit and push the index repository.
6. Push the plugin commit. The `Plugin index` workflow re-runs and must pass
   against the published index.
7. Verify the new version appears in **Plugins → Discover** and can be
   installed or updated.

If the index is not updated, the version-changing workflow fails with the
missing version or commit in its message.
