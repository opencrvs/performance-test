# General informaiton

Goal of this helm chart is to provide developer and tester a way to run performance data generator on remote server.

Helm chart creates one time kubernetes job to generate data.

# Values

Create you own `values.yaml` using values.yaml as reference.


# Install/Upgrade from your laptop

Example of custom perf-test.yaml file**

```yaml
env:
  GATEWAY_URL: https://gateway.tmp-prod.opencrvs.dev
  EVENTS_URL: https://events.tmp-prod.opencrvs.dev

```


**Install/upgrade command**

```
helm upgrade \
  --install \
  -f perf-test.yaml \
  perf-test-job chart/perf-test/
```


# Install/Upgrade from GitHub Actions workflow

Please create all required secrets/variables before adding this code snipped to GitHub actions

```
helm upgrade \
  --install \
  --set env.GATEWAY_URL=https://gateway.${{ vars.domain }} \
  --set env.EVENTS_URL=https://events.${{ vars.domain }} \
  --set postgres.user=${{ secrets.POSTGRES_USER }} \
  --set postgres.password=${{ secrets.POSTGRES_PASSWORD }} \
  --set postgres.host=${{ vars.POSTGRES_HOSTNAME }} \
  perf-test-job oci://ghcr.io/opencrvs/perf-test:0.1.0
```
