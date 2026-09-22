// Hello Beaches — optional settings. Edit, commit, push; there is no build step.
window.HELLO_BEACHES_CONFIG = {
  // Flickr API key from https://www.flickr.com/services/apps/create/ (Flickr Pro accounts only).
  // Leave empty to use Wikimedia Commons for the geo-tagged photo layer.
  flickrApiKey: '',

  // Google Maps Platform key with "Places API (New)" enabled, restricted to this site's domain.
  // Used only when the free sources have no photo that looks like the beach. Read the README section
  // "Google photos as a fallback" first: it explains the daily quota cap that keeps this free.
  googleMapsApiKey: '',
  googlePhotoLimit: 2,     // photos per beach from Google; each image load is one metered "Place Details Photos" event
  googleDailyBudget: 20,   // photo loads per browser per day (soft limit; the hard limit is the Cloud Console quota)
};
