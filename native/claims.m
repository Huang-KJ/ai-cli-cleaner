#import <Foundation/Foundation.h>
#import <sys/stat.h>
#import <sys/acl.h>
#import <sys/fcntl.h>
#import <unistd.h>
#import <errno.h>

static void fail(NSString *message) {
  @throw [NSException exceptionWithName:@"ClaimFailure" reason:message userInfo:nil];
}
static uint64_t number(id value) {
  NSString *text = [value description];
  NSScanner *scan = [NSScanner scannerWithString:text];
  unsigned long long result;
  if (![scan scanUnsignedLongLong:&result] || !scan.isAtEnd) fail(@"Invalid filesystem identity.");
  return result;
}
static BOOL same(struct stat info, NSDictionary *identity) {
  if ((uint64_t)info.st_dev != number(identity[@"device"]) || info.st_ino != number(identity[@"inode"])) return NO;
  NSString *kind = identity[@"kind"];
  if (kind && !([kind isEqual:@"file"] ? S_ISREG(info.st_mode) : [kind isEqual:@"directory"] && S_ISDIR(info.st_mode))) return NO;
  if (identity[@"mode"] && (info.st_mode & S_IFMT) != (number(identity[@"mode"]) & S_IFMT)) return NO;
  return !S_ISLNK(info.st_mode);
}
static void privateDir(int fd) {
  struct stat info;
  if (fstat(fd, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0700) fail(@"Claim storage must be owned by the current user with mode 0700.");
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) {
    if (errno != ENOENT && errno != ENOTSUP) fail(@"Claim storage ACL could not be checked.");
    return;
  }
  acl_entry_t entry;
  int present = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  acl_free(acl);
  if (present == 0) fail(@"Claim storage must not have an extended ACL.");
  if (present < 0 && errno != EINVAL) fail(@"Claim storage ACL could not be checked.");
}
static void trustedDir(int fd) {
  struct stat info;
  if (fstat(fd, &info) || (info.st_uid != 0 && info.st_uid != getuid()) || ((info.st_mode & 0022) && !(info.st_uid == 0 && (info.st_mode & S_ISVTX)))) fail(@"Claim storage ancestor is writable by an untrusted principal.");
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) { if (errno != ENOENT && errno != ENOTSUP) fail(@"Claim ancestor ACL could not be checked."); return; }
  @try {
    acl_entry_t entry;
    for (int flag = ACL_FIRST_ENTRY; acl_get_entry(acl, flag, &entry) == 0; flag = ACL_NEXT_ENTRY) {
      acl_tag_t tag; acl_permset_t perms;
      if (acl_get_tag_type(entry, &tag) || acl_get_permset(entry, &perms)) fail(@"Claim ancestor ACL could not be checked.");
      if (tag != ACL_EXTENDED_ALLOW) continue;
      acl_perm_t writes[] = { ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_DELETE, ACL_DELETE_CHILD, ACL_WRITE_ATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER };
      for (size_t index = 0; index < sizeof(writes) / sizeof(writes[0]); index++) if (acl_get_perm_np(perms, writes[index]) == 1) fail(@"Claim storage ancestor ACL grants untrusted writes.");
    }
  } @finally { acl_free(acl); }
}
// 每層都從已開啟的父目錄取得，拒絕符號連結並核對預先固定的目錄身分。
static int openDir(NSString *directory, NSDictionary *anchors) {
  if (![directory hasPrefix:@"/"] || [directory containsString:@"//"] || [directory.pathComponents containsObject:@".."] || [directory.pathComponents containsObject:@"."]) fail(@"Claim paths must be normalized absolute paths.");
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail(@"Cannot open filesystem root.");
  @try {
    NSString *current = @"";
    for (NSString *part in directory.pathComponents) {
      if ([part isEqual:@"/"]) continue;
      int next = openat(fd, part.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) fail(@"A claim parent directory changed or was redirected.");
      close(fd); fd = next;
      current = [current stringByAppendingFormat:@"/%@", part];
      NSDictionary *expected = anchors[current];
      struct stat info;
      if (!expected || fstat(fd, &info) || !same(info, expected)) fail(@"A claim parent directory identity changed.");
      if ([expected[@"trusted"] boolValue]) trustedDir(fd);
      if ([expected[@"private"] boolValue]) privateDir(fd);
    }
    return fd;
  } @catch (NSException *error) { close(fd); @throw error; }
}
static void syncDir(int fd) { if (fsync(fd)) fail(@"Claim directory could not be synchronized; data was retained."); }
static void save(int stage, NSMutableDictionary *record) {
  NSError *error = nil;
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingPrettyPrinted error:&error];
  if (!bytes || error) fail(@"Claim recovery record could not be encoded.");
  NSString *name = [NSString stringWithFormat:@"claim-%@.tmp", NSUUID.UUID.UUIDString];
  int fd = openat(stage, name.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) fail(@"Claim recovery record could not be created.");
  @try {
    const uint8_t *cursor = bytes.bytes; size_t remaining = bytes.length;
    while (remaining) {
      ssize_t count = write(fd, cursor, remaining);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) fail(@"Claim recovery record could not be written.");
      cursor += count; remaining -= count;
    }
    if (fsync(fd)) fail(@"Claim recovery record could not be synchronized.");
  } @finally { close(fd); }
  if (renameat(stage, name.fileSystemRepresentation, stage, "claim.json")) fail(@"Claim recovery record could not be published.");
  syncDir(stage);
}
static NSMutableDictionary *load(int stage) {
  int fd = openat(stage, "claim.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail(@"Claim recovery record is missing.");
  NSMutableData *data = [NSMutableData data];
  @try {
    struct stat info;
    if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 || (info.st_mode & 0777) != 0600 || info.st_size > 16 * 1024 * 1024) fail(@"Claim recovery record is not private.");
    uint8_t block[8192]; ssize_t count;
    while ((count = read(fd, block, sizeof(block))) > 0) [data appendBytes:block length:(NSUInteger)count];
    if (count < 0) fail(@"Claim recovery record could not be read.");
  } @finally { close(fd); }
  NSError *error = nil;
  id record = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:&error];
  if (error || ![record isKindOfClass:NSDictionary.class] || [record[@"formatVersion"] intValue] != 1) fail(@"Claim recovery record is invalid.");
  return record;
}
static void absent(int parent, NSString *leaf) {
  struct stat info;
  if (!fstatat(parent, leaf.fileSystemRepresentation, &info, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) fail(@"An unexpected object appeared at a claim or publish destination.");
}
static BOOL restore(int original, NSMutableDictionary *target, NSDictionary *anchors) {
  NSString *source = target[@"source"], *slot = target[@"slot"];
  int parent = -1;
  @try {
    parent = openDir(source.stringByDeletingLastPathComponent, anchors);
    if (renameatx_np(original, slot.fileSystemRepresentation, parent, source.lastPathComponent.fileSystemRepresentation, RENAME_EXCL)) return NO;
    syncDir(parent); syncDir(original);
    target[@"state"] = @"restored";
    return YES;
  } @catch (NSException *error) { return NO; }
  @finally { if (parent >= 0) close(parent); }
}
static void claim(int stage, NSMutableDictionary *record) {
  NSDictionary *anchors = record[@"anchors"];
  if (mkdirat(stage, "original", 0700)) fail(@"Claim original storage already exists or cannot be created.");
  int original = openat(stage, "original", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (original < 0) fail(@"Claim original storage could not be opened.");
  @try {
    privateDir(original); syncDir(stage);
    record[@"state"] = @"claiming"; save(stage, record);
    @try {
      for (NSMutableDictionary *target in record[@"targets"]) {
        NSString *source = target[@"source"];
        int parent = openDir(target[@"missingParent"] ?: source.stringByDeletingLastPathComponent, anchors);
        @try {
          NSDictionary *identity = target[@"identity"];
          if (!identity) { absent(parent, target[@"missingLeaf"] ?: source.lastPathComponent); target[@"state"] = @"absent"; save(stage, record); continue; }
          struct stat storage, parentInfo;
          if (fstat(original, &storage) || fstat(parent, &parentInfo) || storage.st_dev != parentInfo.st_dev) fail(@"Claim requires storage on the source filesystem.");
          if (renameatx_np(parent, source.lastPathComponent.fileSystemRepresentation, original, [target[@"slot"] fileSystemRepresentation], RENAME_EXCL)) fail(@"Source claim failed; no replacement was overwritten.");
          target[@"state"] = @"claimed";
          syncDir(parent); syncDir(original); save(stage, record);
          struct stat info;
          if (fstatat(original, [target[@"slot"] fileSystemRepresentation], &info, AT_SYMLINK_NOFOLLOW) || !same(info, identity)) fail(@"Claimed source identity changed; refusing to use the staged object.");
        } @finally { close(parent); }
      }
      record[@"state"] = @"claimed"; save(stage, record);
    } @catch (NSException *error) {
      BOOL restored = YES;
      for (NSMutableDictionary *target in [record[@"targets"] reverseObjectEnumerator]) {
        if ([target[@"state"] isEqual:@"claimed"] && !restore(original, target, anchors)) restored = NO;
      }
      record[@"state"] = restored ? @"restored" : @"held";
      record[@"failure"] = error.reason; save(stage, record);
      fail([NSString stringWithFormat:@"%@ Recovery data was retained; rollback %@.", error.reason, restored ? @"completed" : @"could not restore every source without overwriting a new object"]);
    }
  } @finally { close(original); }
}
static void publish(int stage, NSMutableDictionary *record, NSDictionary *request) {
  if (![record[@"state"] isEqual:@"claimed"]) fail(@"Claim is not ready to publish.");
  NSDictionary *anchors = record[@"anchors"], *replacements = request[@"replacements"];
  NSString *directory = record[@"directory"];
  NSArray *targets = record[@"targets"];
  // 所有目的地必須仍不存在；RENAME_EXCL再次保障檢查後的並行建立。
  for (NSDictionary *target in targets) {
    NSString *source = target[@"source"];
    int parent = openDir(target[@"missingParent"] ?: source.stringByDeletingLastPathComponent, anchors);
    @try { absent(parent, target[@"missingLeaf"] ?: source.lastPathComponent); } @finally { close(parent); }
  }
  record[@"state"] = @"publishing"; record[@"replacements"] = replacements; save(stage, record);
  @try {
    for (NSMutableDictionary *target in targets) {
      NSString *source = target[@"source"], *work = replacements[source][@"path"];
      if (!work) continue;
      if (target[@"missingParent"]) fail(@"Cannot publish into an unapproved newly created parent directory.");
      NSString *prefix = [directory stringByAppendingString:@"/work/"];
      if (![work hasPrefix:prefix] || [work containsString:@"//"] || [work.pathComponents containsObject:@".."] || [work.pathComponents containsObject:@"."]) fail(@"Publish inputs must be private work files.");
      int workParent = openDir(work.stringByDeletingLastPathComponent, request[@"workAnchors"]);
      int parent = -1;
      @try {
        privateDir(workParent);
        struct stat info;
        if (fstatat(workParent, work.lastPathComponent.fileSystemRepresentation, &info, AT_SYMLINK_NOFOLLOW) || !same(info, replacements[source][@"identity"]) || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 || (info.st_mode & 0777) != 0600) fail(@"Publish work file must be a private single-link regular file.");
        int fd = openat(workParent, work.lastPathComponent.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) fail(@"Publish work file could not be synchronized.");
        int synced = fsync(fd); close(fd); if (synced) fail(@"Publish work file could not be synchronized.");
        parent = openDir(source.stringByDeletingLastPathComponent, anchors);
        if (renameatx_np(workParent, work.lastPathComponent.fileSystemRepresentation, parent, source.lastPathComponent.fileSystemRepresentation, RENAME_EXCL)) fail(@"Publish failed; an existing destination was not overwritten.");
        target[@"published"] = @YES;
        syncDir(workParent); syncDir(parent); save(stage, record);
      } @finally { close(workParent); if (parent >= 0) close(parent); }
    }
    for (NSDictionary *target in targets) {
      NSString *source = target[@"source"];
      int parent = openDir(target[@"missingParent"] ?: source.stringByDeletingLastPathComponent, anchors);
      @try {
        NSDictionary *replacement = replacements[source];
        if (!replacement) { absent(parent, target[@"missingLeaf"] ?: source.lastPathComponent); continue; }
        struct stat info;
        if (fstatat(parent, source.lastPathComponent.fileSystemRepresentation, &info, AT_SYMLINK_NOFOLLOW) || !same(info, replacement[@"identity"])) fail(@"Published file identity changed; original recovery data was retained.");
      } @finally { close(parent); }
    }
    record[@"state"] = @"published"; save(stage, record);
  } @catch (NSException *error) {
    record[@"state"] = @"partial"; record[@"failure"] = error.reason; save(stage, record); @throw error;
  }
}
int main(void) { @autoreleasepool {
  @try {
    NSData *input = NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    if (input.length > 16 * 1024 * 1024) fail(@"Claim request is too large.");
    NSError *error = nil;
    NSMutableDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:NSJSONReadingMutableContainers error:&error];
    if (error || ![request isKindOfClass:NSDictionary.class]) fail(@"Invalid claim request.");
    NSString *directory = request[@"directory"], *operation = request[@"operation"];
    int stage = openDir(directory, request[@"anchors"]);
    @try {
      privateDir(stage);
      if ([operation isEqual:@"claim"]) {
        NSMutableDictionary *record = [@{ @"formatVersion": @1, @"directory": directory, @"anchors": request[@"anchors"], @"targets": request[@"targets"] } mutableCopy];
        claim(stage, record);
      } else {
        NSMutableDictionary *record = load(stage);
        if (![record[@"directory"] isEqual:directory]) fail(@"Claim recovery directory does not match.");
        if ([operation isEqual:@"publish"]) publish(stage, record, request);
        else if ([operation isEqual:@"trashed"]) {
          if (![record[@"state"] isEqual:@"claimed"]) fail(@"Only verified claims may be marked trashed.");
          int original = openat(stage, "original", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
          if (original < 0) fail(@"Claim original storage is missing.");
          @try {
            privateDir(original);
            for (NSDictionary *target in record[@"targets"]) if (target[@"identity"]) absent(original, target[@"slot"]);
          } @finally { close(original); }
          record[@"state"] = @"trashed"; save(stage, record);
        }
        else if ([operation isEqual:@"rollback"]) {
          int original = openat(stage, "original", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
          if (original < 0) fail(@"Rollback original storage is missing.");
          BOOL restored = YES;
          @try {
            privateDir(original);
            for (NSMutableDictionary *target in [record[@"targets"] reverseObjectEnumerator]) {
              if ([target[@"state"] isEqual:@"claimed"] && !restore(original, target, record[@"anchors"])) restored = NO;
            }
          } @finally { close(original); }
          record[@"state"] = restored ? @"restored" : @"held"; save(stage, record);
          if (!restored) fail(@"Rollback could not restore sources without overwriting new objects; recovery data was retained.");
        } else fail(@"Unsupported claim operation.");
      }
    } @finally { close(stage); }
    puts("{\"ok\":true}"); return 0;
  } @catch (NSException *error) {
    fprintf(stderr, "%s\n", error.reason.UTF8String); return 1;
  }
} }
