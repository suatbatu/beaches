// Hello Beaches — optional settings. Edit, commit, push; there is no build step.
window.HELLO_BEACHES_CONFIG = {
  // Supabase project for shared ratings and Google data. Leave empty and the site still works:
  // ratings are then kept on each visitor's own device. Setup steps are in the README.
  supabaseUrl: '',   // e.g. 'https://abcdefghijklmnop.supabase.co'
  supabaseKey: '',   // the project's publishable key (sb_publishable_...), which is meant to be public

  // Google Maps ratings and photos, through the google-place Edge Function. Turn on only after the
  // function is deployed with its GOOGLE_MAPS_API_KEY secret. The Google key never goes in this file.
  useGoogle: false,
  googlePhotoLimit: 2,   // Google photos per beach, used only when free sources have none of the beach

  // Flickr API key (Flickr Pro accounts only). Leave empty to use Wikimedia Commons.
  flickrApiKey: '',
};
