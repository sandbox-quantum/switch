# The box image

This folder builds the box image from this repository's packages: `build.sh` packs the controller (or takes a package
packed earlier) and builds the image on `Dockerfile`, with `entrypoint.sh` as its entrypoint.
`Dockerfile.controller-update` builds the controller update image. `../../build-push-images.sh` builds and pushes
both v2 images from a clean checkout and prints their digests.

The box cluster's own settings and manifests (the EKS add-on values, the `switch-box` priority class, the namespaces,
policies and services) live in the deployment repository, which applies them and checks them against this
repository's operator through `deploy/hosted/contract/`.
