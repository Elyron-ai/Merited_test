/** @type {import('next').NextConfig} */
export default {
  // pg is a server-only native-ish dep; keep it external to the bundle
  serverExternalPackages: ['pg', 'argon2'],
};
